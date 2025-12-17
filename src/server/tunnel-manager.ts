import type { ServerWebSocket } from "bun";
import type { ServerMessage, ClientMessage } from "../shared/protocol.ts";

interface PendingRequest {
  requestId: string;
  resolve: (response: TunnelResponse) => void;
  reject: (error: Error) => void;
  timeout: Timer;
}

interface TunnelResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface TunnelData {
  subdomain: string;
  apiKey: string;
}

interface ActiveTunnel {
  ws: ServerWebSocket<TunnelData>;
  subdomain: string;
  apiKey: string;
  createdAt: number;
  pendingRequests: Map<string, PendingRequest>;
}

const REQUEST_TIMEOUT = 30000; // 30 seconds

class TunnelManager {
  private tunnels = new Map<string, ActiveTunnel>();

  register(subdomain: string, ws: ServerWebSocket<TunnelData>, apiKey: string): void {
    this.tunnels.set(subdomain, {
      ws,
      subdomain,
      apiKey,
      createdAt: Date.now(),
      pendingRequests: new Map(),
    });
    console.log(`[tunnel] Registered: ${subdomain}`);
  }

  unregister(subdomain: string): void {
    const tunnel = this.tunnels.get(subdomain);
    if (tunnel) {
      // Reject all pending requests
      for (const pending of tunnel.pendingRequests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Tunnel disconnected"));
      }
      this.tunnels.delete(subdomain);
      console.log(`[tunnel] Unregistered: ${subdomain}`);
    }
  }

  get(subdomain: string): ActiveTunnel | undefined {
    return this.tunnels.get(subdomain);
  }

  has(subdomain: string): boolean {
    return this.tunnels.has(subdomain);
  }

  async proxyRequest(
    subdomain: string,
    req: Request
  ): Promise<Response> {
    const tunnel = this.tunnels.get(subdomain);
    if (!tunnel) {
      return new Response("Tunnel not found", { status: 404 });
    }

    const requestId = crypto.randomUUID();
    const url = new URL(req.url);

    // Read body if present
    let body: string | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await req.text();
    }

    // Convert headers
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Send request to CLI
    const message: ServerMessage = {
      type: "http_request",
      requestId,
      method: req.method,
      path: url.pathname + url.search,
      headers,
      body,
    };

    return new Promise<Response>((resolve, reject) => {
      const timeout = setTimeout(() => {
        tunnel.pendingRequests.delete(requestId);
        resolve(new Response("Gateway Timeout", { status: 504 }));
      }, REQUEST_TIMEOUT);

      tunnel.pendingRequests.set(requestId, {
        requestId,
        resolve: (tunnelResponse) => {
          resolve(
            new Response(tunnelResponse.body, {
              status: tunnelResponse.status,
              headers: tunnelResponse.headers,
            })
          );
        },
        reject: (error) => {
          resolve(new Response(error.message, { status: 502 }));
        },
        timeout,
      });

      tunnel.ws.send(JSON.stringify(message));
    });
  }

  handleResponse(subdomain: string, message: ClientMessage): void {
    if (message.type !== "http_response") return;

    const tunnel = this.tunnels.get(subdomain);
    const pending = tunnel?.pendingRequests.get(message.requestId);

    if (pending) {
      clearTimeout(pending.timeout);
      tunnel!.pendingRequests.delete(message.requestId);
      pending.resolve({
        status: message.status,
        headers: message.headers,
        body: message.body,
      });
    }
  }

  getStats() {
    return {
      activeTunnels: this.tunnels.size,
      tunnels: Array.from(this.tunnels.values()).map((t) => ({
        subdomain: t.subdomain,
        createdAt: t.createdAt,
        pendingRequests: t.pendingRequests.size,
      })),
    };
  }
}

export const tunnelManager = new TunnelManager();
