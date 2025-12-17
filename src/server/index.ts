import { getServerConfig } from "../shared/types.ts";
import type { ServerMessage, ClientMessage } from "../shared/protocol.ts";
import { verifyApiKey } from "./auth.ts";
import { generateSubdomain } from "./subdomain.ts";
import { tunnelManager, type TunnelData } from "./tunnel-manager.ts";
import { CaddyApi } from "./caddy-api.ts";

const config = getServerConfig();
const caddy = new CaddyApi(config.caddyAdminUrl, config.baseDomain, config.tunnelPort);

// Check Caddy availability on startup
const caddyAvailable = await caddy.isAvailable();
if (!caddyAvailable) {
  console.warn(
    `[server] Warning: Caddy Admin API not available at ${config.caddyAdminUrl}`
  );
  console.warn(`[server] Routes won't be automatically registered`);
}

const server = Bun.serve<TunnelData>({
  port: config.tunnelPort,

  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade for tunnel connections
    if (url.pathname === "/__tunnel__/connect") {
      const apiKey = req.headers.get("x-api-key");

      if (!verifyApiKey(apiKey, config.apiKey)) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Check for requested subdomain (for reconnects or custom subdomain)
      let subdomain = url.searchParams.get("subdomain");

      if (subdomain) {
        // Validate subdomain format (lowercase alphanumeric and hyphens)
        if (!/^[a-z0-9-]+$/.test(subdomain)) {
          return new Response("Invalid subdomain format", { status: 400 });
        }
        // Check if subdomain is already in use
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

      const upgraded = server.upgrade(req, {
        data: { subdomain, apiKey: apiKey! },
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

    // Status endpoint
    if (url.pathname === "/__tunnel__/status") {
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
      try {
        const parsed = JSON.parse(message.toString()) as ClientMessage;
        const { subdomain } = ws.data;

        if (parsed.type === "pong") {
          // Heartbeat response - nothing to do
          return;
        }

        // Handle all response types (regular and streaming)
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
