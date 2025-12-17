import type { ServerWebSocket } from "bun";
import type { ServerMessage, ClientMessage } from "../shared/protocol.ts";

interface PendingRequest {
  requestId: string;
  resolve: (response: TunnelResponse) => void;
  reject: (error: Error) => void;
  timeout: Timer;
}

// Binary response waiting for body frame
interface PendingBinaryHeader {
  requestId: string;
  status: number;
  headers: Record<string, string>;
}

// Streaming response state
interface ActiveStream {
  requestId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  // Waiting for next chunk's binary frame
  pendingChunkSize: number | null;
}

interface TunnelResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string | ReadableStream<Uint8Array>;
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
  // Header for next binary frame
  pendingBinaryHeader: PendingBinaryHeader | null;
  // Active streams (streaming responses)
  activeStreams: Map<string, ActiveStream>;
  // Ping interval timer
  pingInterval: Timer | null;
}

const REQUEST_TIMEOUT = 30000; // 30 seconds
const PING_INTERVAL = 20000; // 20 seconds - keep connection alive

class TunnelManager {
  private tunnels = new Map<string, ActiveTunnel>();

  register(subdomain: string, ws: ServerWebSocket<TunnelData>, apiKey: string): void {
    // Start ping interval to keep WebSocket alive
    const pingInterval = setInterval(() => {
      const tunnel = this.tunnels.get(subdomain);
      if (tunnel && tunnel.ws.readyState === 1) { // WebSocket.OPEN
        tunnel.ws.ping(); // Native WebSocket ping
      }
    }, PING_INTERVAL);

    this.tunnels.set(subdomain, {
      ws,
      subdomain,
      apiKey,
      createdAt: Date.now(),
      pendingRequests: new Map(),
      pendingBinaryHeader: null,
      activeStreams: new Map(),
      pingInterval,
    });
    console.log(`[tunnel] Registered: ${subdomain}`);
  }

  unregister(subdomain: string): void {
    const tunnel = this.tunnels.get(subdomain);
    if (tunnel) {
      // Stop ping interval
      if (tunnel.pingInterval) {
        clearInterval(tunnel.pingInterval);
      }
      // Reject all pending requests
      for (const pending of tunnel.pendingRequests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Tunnel disconnected"));
      }
      // Close all active streams with error
      for (const stream of tunnel.activeStreams.values()) {
        try {
          stream.controller.error(new Error("Tunnel disconnected"));
        } catch {
          // Stream may already be closed
        }
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
      serverTimestamp: Date.now(),
    };

    return new Promise<Response>((resolve) => {
      const timeout = setTimeout(() => {
        tunnel.pendingRequests.delete(requestId);
        resolve(new Response("Gateway Timeout", { status: 504 }));
      }, REQUEST_TIMEOUT);

      tunnel.pendingRequests.set(requestId, {
        requestId,
        resolve: (tunnelResponse) => {
          // Body can be: string (text), Uint8Array (binary), or ReadableStream (streaming)
          let body: BodyInit;
          if (tunnelResponse.body instanceof Uint8Array) {
            body = tunnelResponse.body.buffer.slice(0) as ArrayBuffer;
          } else if (tunnelResponse.body instanceof ReadableStream) {
            // Streaming response - pass stream directly
            body = tunnelResponse.body;
          } else {
            body = tunnelResponse.body;
          }
          resolve(
            new Response(body, {
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

      // Check WebSocket state before sending (race condition fix)
      if (tunnel.ws.readyState === 1) { // WebSocket.OPEN
        tunnel.ws.send(JSON.stringify(message));
      } else {
        clearTimeout(timeout);
        tunnel.pendingRequests.delete(requestId);
        resolve(new Response("Tunnel disconnected", { status: 502 }));
      }
    });
  }

  handleResponse(subdomain: string, message: ClientMessage): void {
    const tunnel = this.tunnels.get(subdomain);
    if (!tunnel) return;

    if (message.type === "http_response") {
      // Small text response - body inline
      const pending = tunnel.pendingRequests.get(message.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        tunnel.pendingRequests.delete(message.requestId);
        pending.resolve({
          status: message.status,
          headers: message.headers,
          body: message.body,
        });
      }
      return;
    }

    if (message.type === "http_response_binary") {
      // Binary response header - store and wait for binary frame
      tunnel.pendingBinaryHeader = {
        requestId: message.requestId,
        status: message.status,
        headers: message.headers,
      };
      return;
    }

    if (message.type === "http_response_stream_start") {
      // Start streaming response
      const pending = tunnel.pendingRequests.get(message.requestId);
      if (!pending) return;

      // Clear the original timeout - streaming can take longer
      clearTimeout(pending.timeout);

      // Create ReadableStream for the response body
      let streamController: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      });

      // Store stream state
      tunnel.activeStreams.set(message.requestId, {
        requestId: message.requestId,
        controller: streamController!,
        pendingChunkSize: null,
      });

      // Resolve with streaming response
      tunnel.pendingRequests.delete(message.requestId);
      pending.resolve({
        status: message.status,
        headers: message.headers,
        body: stream as unknown as string, // Type hack - we handle ReadableStream specially
      });
      return;
    }

    if (message.type === "http_response_stream_chunk") {
      // Chunk header - store size and wait for binary frame
      const stream = tunnel.activeStreams.get(message.requestId);
      if (stream) {
        stream.pendingChunkSize = message.chunkSize;
      }
      return;
    }

    if (message.type === "http_response_stream_end") {
      // End stream
      const stream = tunnel.activeStreams.get(message.requestId);
      if (stream) {
        try {
          stream.controller.close();
        } catch {
          // Stream may already be closed
        }
        tunnel.activeStreams.delete(message.requestId);
      }
      return;
    }

    if (message.type === "http_response_stream_error") {
      // Stream error
      const stream = tunnel.activeStreams.get(message.requestId);
      if (stream) {
        try {
          stream.controller.error(new Error(message.error));
        } catch {
          // Stream may already be closed
        }
        tunnel.activeStreams.delete(message.requestId);
      }
      return;
    }
  }

  // Handle binary WebSocket frame (body for http_response_binary or stream chunk)
  handleBinaryMessage(subdomain: string, data: Uint8Array): void {
    const tunnel = this.tunnels.get(subdomain);
    if (!tunnel) return;

    // Check for pending binary header (non-streaming)
    if (tunnel.pendingBinaryHeader) {
      const header = tunnel.pendingBinaryHeader;
      tunnel.pendingBinaryHeader = null;

      const pending = tunnel.pendingRequests.get(header.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        tunnel.pendingRequests.delete(header.requestId);
        pending.resolve({
          status: header.status,
          headers: header.headers,
          body: data,
        });
      }
      return;
    }

    // Check for active stream waiting for chunk data
    for (const stream of tunnel.activeStreams.values()) {
      if (stream.pendingChunkSize !== null) {
        stream.pendingChunkSize = null;
        try {
          stream.controller.enqueue(data);
        } catch {
          // Stream may be closed by client
          tunnel.activeStreams.delete(stream.requestId);
        }
        return;
      }
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

  // Helper methods for graceful shutdown
  getAllTunnels(): ActiveTunnel[] {
    return Array.from(this.tunnels.values());
  }

  hasPendingRequests(): boolean {
    for (const tunnel of this.tunnels.values()) {
      if (tunnel.pendingRequests.size > 0) return true;
    }
    return false;
  }
}

export const tunnelManager = new TunnelManager();
