import { getServerConfig } from "../shared/types.ts";
import type { ServerMessage, ClientMessage } from "../shared/protocol.ts";
import { verifyApiKey } from "./auth.ts";
import { generateSubdomain } from "./subdomain.ts";
import { tunnelManager, type TunnelData } from "./tunnel-manager.ts";
import { CaddyApi } from "./caddy-api.ts";
import { subdomainCache } from "./subdomain-cache.ts";

const config = getServerConfig();
const caddy = new CaddyApi(config.caddyAdminUrl, config.baseDomain, config.tunnelPort);

// Load persistent subdomain cache
await subdomainCache.load();

// Check Caddy availability on startup
const caddyAvailable = await caddy.isAvailable();
if (!caddyAvailable) {
  console.warn(
    `[server] Warning: Caddy Admin API not available at ${config.caddyAdminUrl}`
  );
  console.warn(`[server] Routes won't be automatically registered`);
}

Bun.serve<TunnelData>({
  port: config.tunnelPort,

  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade for tunnel connections
    if (url.pathname === "/__tunnel__/connect") {
      const apiKey = req.headers.get("x-api-key");

      if (!apiKey || !verifyApiKey(apiKey, config.apiKey)) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Get client port for subdomain caching
      const clientPort = parseInt(url.searchParams.get("port") || "0", 10);

      // Check for requested subdomain, or use cached subdomain for this apiKey+port
      let subdomain = url.searchParams.get("subdomain");
      const cachedSubdomain = clientPort > 0 ? subdomainCache.get(apiKey, clientPort) : undefined;

      console.log(`[tunnel] Connect request: port=${clientPort}, subdomain=${subdomain || "(none)"}, cached=${cachedSubdomain || "(none)"}`);

      // Priority: explicit subdomain > cached subdomain > generate new
      if (!subdomain && cachedSubdomain) {
        subdomain = cachedSubdomain;
      }

      if (subdomain) {
        // Validate subdomain format (lowercase alphanumeric and hyphens)
        if (!/^[a-z0-9-]+$/.test(subdomain)) {
          return new Response("Invalid subdomain format", { status: 400 });
        }

        // Check if subdomain is reserved by different client
        if (subdomainCache.isReservedByOther(apiKey, clientPort, subdomain)) {
          return new Response("Subdomain reserved by another client", { status: 409 });
        }

        // Check if subdomain is already in use (active connection)
        const existingTunnel = tunnelManager.get(subdomain);
        if (existingTunnel) {
          // Same API key = reconnect, close old connection and allow new one
          if (existingTunnel.apiKey === apiKey) {
            console.log(`[tunnel] Closing stale connection for ${subdomain} (reconnect)`);
            existingTunnel.ws.close(1000, "Reconnecting");
            tunnelManager.unregister(subdomain);
          } else {
            return new Response("Subdomain already in use", { status: 409 });
          }
        }
      } else {
        subdomain = generateSubdomain();
      }

      // Cache subdomain for this apiKey+port
      if (clientPort > 0) {
        subdomainCache.set(apiKey, clientPort, subdomain);
      }

      const upgraded = server.upgrade(req, {
        data: { subdomain, apiKey },
      });

      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      return undefined;
    }

    // API key verification endpoint
    if (url.pathname === "/__tunnel__/verify") {
      const apiKey = req.headers.get("x-api-key");
      if (!verifyApiKey(apiKey, config.apiKey)) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response("OK", { status: 200 });
    }

    // Health check endpoint (no auth required)
    if (url.pathname === "/__tunnel__/health") {
      return new Response("OK", { status: 200 });
    }

    // Status endpoint (requires auth)
    if (url.pathname === "/__tunnel__/status") {
      const apiKey = req.headers.get("x-api-key");
      if (!apiKey || !verifyApiKey(apiKey, config.apiKey)) {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json(tunnelManager.getStats());
    }

    // Handle tunneled HTTP requests
    // Subdomain comes from X-Tunnel-Subdomain header (set by Caddy)
    // or from Host header directly
    let subdomain = req.headers.get("x-tunnel-subdomain");

    if (!subdomain) {
      const host = req.headers.get("host");
      if (host) {
        // Extract subdomain from host: "brave-fox-1234.tunnel.example.com"
        const match = host.match(/^([^.]+)\./);
        if (match?.[1]) {
          subdomain = match[1];
        }
      }
    }

    if (!subdomain || !tunnelManager.has(subdomain)) {
      return new Response("Tunnel not found", { status: 404 });
    }

    return tunnelManager.proxyRequest(subdomain, req);
  },

  websocket: {
    open(ws) {
      const { subdomain, apiKey } = ws.data;
      tunnelManager.register(subdomain, ws, apiKey);

      // No need to register individual routes in Caddy - wildcard *.tunnel.domain handles all
      // Adding routes via Admin API causes Caddy to reload, which closes WebSocket connections!

      // Send connection confirmation
      const message: ServerMessage = {
        type: "connected",
        subdomain,
        publicUrl: `https://${subdomain}.${config.baseDomain}`,
      };
      ws.send(JSON.stringify(message));
    },

    message(ws, message) {
      const { subdomain } = ws.data;

      // Binary frame = body for previous http_response_binary header
      if (message instanceof ArrayBuffer || message instanceof Uint8Array) {
        const data = message instanceof ArrayBuffer ? new Uint8Array(message) : message;
        tunnelManager.handleBinaryMessage(subdomain, data);
        return;
      }

      // Text frame = JSON message
      try {
        const parsed = JSON.parse(message.toString()) as ClientMessage;

        if (parsed.type === "pong") {
          return;
        }

        tunnelManager.handleResponse(subdomain, parsed);
      } catch (error) {
        console.error("[ws] Failed to parse message:", error);
      }
    },

    close(ws) {
      const { subdomain } = ws.data;
      tunnelManager.unregister(subdomain);
      // No Caddy route cleanup needed - using wildcard
    },

    // Heartbeat to keep connection alive
    idleTimeout: 120,
  },
});

console.log(`[server] Fast-ngrok server running on port ${config.tunnelPort}`);
console.log(`[server] Base domain: ${config.baseDomain}`);
console.log(`[server] Caddy API: ${caddyAvailable ? "available" : "not available"}`);

// Graceful shutdown handlers
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[server] ${signal} received, shutting down gracefully...`);

  // 1. Close all tunnels with notification
  for (const tunnel of tunnelManager.getAllTunnels()) {
    tunnel.ws.close(1001, "Server shutting down");
  }

  // 2. Wait for pending requests to complete (max 5s)
  const start = Date.now();
  while (tunnelManager.hasPendingRequests() && Date.now() - start < 5000) {
    await Bun.sleep(100);
  }

  // 3. Force save subdomain cache
  await subdomainCache.forceSave();

  console.log("[server] Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
