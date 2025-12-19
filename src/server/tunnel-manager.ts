import type { ServerWebSocket } from "bun";
import type { ServerMessage, ClientMessage } from "../shared/protocol.ts";

interface PendingRequest {
  requestId: string;
  startTime: number; // Date.now() when server received HTTP request
  resolve: (response: TunnelResponse) => void;
  reject: (error: Error) => void;
  timeout: Timer;
}

// WebSocket passthrough: pending upgrade waiting for client to connect to localhost
interface PendingWsUpgrade {
  wsId: string;
  resolve: (protocol?: string) => void;
  reject: (error: string) => void;
  timeout: Timer;
}

// WebSocket passthrough: active browser WS connection
interface ActiveBrowserWs {
  wsId: string;
  ws: ServerWebSocket<BrowserWsData>;
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

// Discriminated union for WebSocket data
export type WsData =
  | { type: "tunnel"; subdomain: string; apiKey: string }
  | { type: "browser"; wsId: string; subdomain: string };

// Legacy export for compatibility
export type TunnelData = Extract<WsData, { type: "tunnel" }>;
export type BrowserWsData = Extract<WsData, { type: "browser" }>;

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
  // WebSocket passthrough: pending upgrades waiting for client confirmation
  pendingWsUpgrades: Map<string, PendingWsUpgrade>;
  // WebSocket passthrough: active browser WS connections
  browserWebSockets: Map<string, ActiveBrowserWs>;
  // WebSocket passthrough: pending binary message (wsId for next binary frame)
  pendingWsBinaryWsId: string | null;
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
      pendingWsUpgrades: new Map(),
      browserWebSockets: new Map(),
      pendingWsBinaryWsId: null,
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
      // Reject all pending WS upgrades
      for (const pending of tunnel.pendingWsUpgrades.values()) {
        clearTimeout(pending.timeout);
        pending.reject("Tunnel disconnected");
      }
      // Close all browser WebSockets
      for (const browserWs of tunnel.browserWebSockets.values()) {
        try {
          browserWs.ws.close(1001, "Tunnel disconnected");
        } catch {
          // WS may already be closed
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

    // Track start time for accurate duration measurement
    const startTime = Date.now();

    // Send request to CLI
    const message: ServerMessage = {
      type: "http_request",
      requestId,
      method: req.method,
      path: url.pathname + url.search,
      headers,
      body,
    };

    return new Promise<Response>((resolve) => {
      const timeout = setTimeout(() => {
        tunnel.pendingRequests.delete(requestId);
        resolve(new Response("Gateway Timeout", { status: 504 }));
      }, REQUEST_TIMEOUT);

      tunnel.pendingRequests.set(requestId, {
        requestId,
        startTime,
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

          // Calculate real duration and send to CLI
          const duration = Date.now() - startTime;
          const timingMsg: ServerMessage = {
            type: "request_timing",
            requestId,
            duration,
          };
          if (tunnel.ws.readyState === 1) {
            tunnel.ws.send(JSON.stringify(timingMsg));
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

    // Check for pending WebSocket binary message
    if (tunnel.pendingWsBinaryWsId) {
      const wsId = tunnel.pendingWsBinaryWsId;
      tunnel.pendingWsBinaryWsId = null;

      const browserWs = tunnel.browserWebSockets.get(wsId);
      if (browserWs && browserWs.ws.readyState === 1) {
        browserWs.ws.send(data);
      }
      return;
    }
  }

  // WebSocket passthrough: check if request is WS upgrade
  isWebSocketUpgrade(req: Request): boolean {
    const upgrade = req.headers.get("upgrade")?.toLowerCase();
    const connection = req.headers.get("connection")?.toLowerCase();
    return upgrade === "websocket" && (connection?.includes("upgrade") ?? false);
  }

  // WebSocket passthrough: initiate upgrade through tunnel
  // Returns wsId to use for browser WS registration
  async initiateWsUpgrade(
    subdomain: string,
    path: string,
    headers: Record<string, string>,
    protocol?: string
  ): Promise<string> {
    const tunnel = this.tunnels.get(subdomain);
    if (!tunnel) {
      throw new Error("Tunnel not found");
    }

    const wsId = crypto.randomUUID();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        tunnel.pendingWsUpgrades.delete(wsId);
        reject(new Error("WebSocket upgrade timeout"));
      }, REQUEST_TIMEOUT);

      tunnel.pendingWsUpgrades.set(wsId, {
        wsId,
        resolve: () => {
          clearTimeout(timeout);
          tunnel.pendingWsUpgrades.delete(wsId);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          tunnel.pendingWsUpgrades.delete(wsId);
          reject(new Error(error));
        },
        timeout,
      });

      // Send ws_open to client
      const message: ServerMessage = {
        type: "ws_open",
        wsId,
        path,
        headers,
        protocol,
      };

      if (tunnel.ws.readyState === 1) {
        tunnel.ws.send(JSON.stringify(message));
      } else {
        clearTimeout(timeout);
        tunnel.pendingWsUpgrades.delete(wsId);
        reject(new Error("Tunnel disconnected"));
      }
    });

    return wsId;
  }

  // WebSocket passthrough: register browser WS after successful upgrade
  registerBrowserWs(subdomain: string, wsId: string, ws: ServerWebSocket<BrowserWsData>): void {
    const tunnel = this.tunnels.get(subdomain);
    if (tunnel) {
      tunnel.browserWebSockets.set(wsId, { wsId, ws });
      console.log(`[ws] Browser WS registered: ${wsId} (subdomain: ${subdomain})`);
    }
  }

  // WebSocket passthrough: unregister browser WS
  unregisterBrowserWs(subdomain: string, wsId: string): void {
    const tunnel = this.tunnels.get(subdomain);
    if (tunnel) {
      tunnel.browserWebSockets.delete(wsId);
      console.log(`[ws] Browser WS unregistered: ${wsId}`);
    }
  }

  // WebSocket passthrough: forward message from browser to client
  forwardBrowserWsMessage(subdomain: string, wsId: string, data: string | ArrayBuffer): void {
    const tunnel = this.tunnels.get(subdomain);
    if (!tunnel || tunnel.ws.readyState !== 1) return;

    if (typeof data === "string") {
      const message: ServerMessage = {
        type: "ws_message",
        wsId,
        data,
      };
      tunnel.ws.send(JSON.stringify(message));
    } else {
      // Binary: send header then binary frame
      const message: ServerMessage = {
        type: "ws_message_binary",
        wsId,
      };
      tunnel.ws.send(JSON.stringify(message));
      tunnel.ws.send(new Uint8Array(data));
    }
  }

  // WebSocket passthrough: notify client that browser closed WS
  notifyBrowserWsClosed(subdomain: string, wsId: string, code?: number, reason?: string): void {
    const tunnel = this.tunnels.get(subdomain);
    if (!tunnel || tunnel.ws.readyState !== 1) return;

    const message: ServerMessage = {
      type: "ws_close",
      wsId,
      code,
      reason,
    };
    tunnel.ws.send(JSON.stringify(message));
  }

  // WebSocket passthrough: handle client WS-related messages
  handleWsResponse(subdomain: string, message: ClientMessage): void {
    const tunnel = this.tunnels.get(subdomain);
    if (!tunnel) return;

    if (message.type === "ws_opened") {
      const pending = tunnel.pendingWsUpgrades.get(message.wsId);
      if (pending) {
        pending.resolve(message.protocol);
      }
      return;
    }

    if (message.type === "ws_error") {
      const pending = tunnel.pendingWsUpgrades.get(message.wsId);
      if (pending) {
        pending.reject(message.error);
      }
      return;
    }

    if (message.type === "ws_message") {
      const browserWs = tunnel.browserWebSockets.get(message.wsId);
      if (browserWs && browserWs.ws.readyState === 1) {
        browserWs.ws.send(message.data);
      }
      return;
    }

    if (message.type === "ws_message_binary") {
      // Next binary frame is for this wsId
      tunnel.pendingWsBinaryWsId = message.wsId;
      return;
    }

    if (message.type === "ws_close") {
      const browserWs = tunnel.browserWebSockets.get(message.wsId);
      if (browserWs) {
        try {
          browserWs.ws.close(message.code ?? 1000, message.reason);
        } catch {
          // Already closed
        }
        tunnel.browserWebSockets.delete(message.wsId);
      }
      return;
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
