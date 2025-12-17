import type { ServerMessage, ClientMessage } from "../shared/protocol.ts";
import type { RequestInfo } from "../shared/types.ts";
import { LocalProxy } from "./local-proxy.ts";

export interface TunnelClientOptions {
  serverUrl: string;
  apiKey: string;
  localPort: number;
  subdomain?: string; // Custom subdomain (optional)
  onRequest?: (req: RequestInfo) => void;
  onResponse?: (id: string, status: number, duration: number, error?: boolean) => void;
  onConnect?: (subdomain: string, publicUrl: string) => void;
  onDisconnect?: () => void;
  onError?: (message: string) => void;
}

export class TunnelClient {
  private ws: WebSocket | null = null;
  private localProxy: LocalProxy;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private shouldReconnect = true;
  private hasConnectedOnce = false; // Only reconnect if we connected at least once
  private pingInterval: Timer | null = null;
  private currentSubdomain: string | null = null; // Preserve across reconnects

  constructor(private options: TunnelClientOptions) {
    this.localProxy = new LocalProxy(options.localPort);
    // Use custom subdomain if provided
    if (options.subdomain) {
      this.currentSubdomain = options.subdomain;
    }
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.options.serverUrl
        .replace("https://", "wss://")
        .replace("http://", "ws://");

      // Build URL with optional subdomain parameter
      let connectUrl = `${wsUrl}/__tunnel__/connect`;
      if (this.currentSubdomain) {
        connectUrl += `?subdomain=${encodeURIComponent(this.currentSubdomain)}`;
      }

      // Bun's WebSocket constructor accepts headers in second argument
      this.ws = new WebSocket(connectUrl, {
        headers: {
          "x-api-key": this.options.apiKey,
        },
      } as unknown as string | string[]);

      this.ws.addEventListener("open", () => {
        this.reconnectAttempts = 0;
        this.startPingInterval();
        resolve();
      });

      this.ws.addEventListener("message", async (event) => {
        await this.handleMessage(event.data.toString());
      });

      this.ws.addEventListener("close", (event) => {
        console.error(`[ws] Connection closed: code=${event.code}, reason=${event.reason}`);
        this.stopPingInterval();
        this.options.onDisconnect?.();

        // Only reconnect if we successfully connected at least once
        if (this.shouldReconnect && this.hasConnectedOnce) {
          this.scheduleReconnect();
        }
      });

      this.ws.addEventListener("error", (error) => {
        this.options.onError?.(`WebSocket error: ${error}`);
        reject(error);
      });
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopPingInterval();
    this.ws?.close();
  }

  private async handleMessage(data: string): Promise<void> {
    try {
      const message = JSON.parse(data) as ServerMessage;

      switch (message.type) {
        case "connected":
          // Save subdomain for reconnects
          this.currentSubdomain = message.subdomain;
          this.hasConnectedOnce = true;
          this.options.onConnect?.(message.subdomain, message.publicUrl);
          break;

        case "http_request":
          await this.handleRequest(message);
          break;

        case "ping":
          this.sendPong();
          break;

        case "error":
          this.options.onError?.(message.message);
          break;
      }
    } catch (error) {
      console.error("Failed to parse message:", error);
    }
  }

  // Threshold for streaming (64KB)
  private static STREAM_THRESHOLD = 64 * 1024;
  // Chunk size for streaming (32KB)
  private static CHUNK_SIZE = 32 * 1024;
  // Minimum size to compress (1KB)
  private static COMPRESS_THRESHOLD = 1024;

  private async handleRequest(message: Extract<ServerMessage, { type: "http_request" }>): Promise<void> {
    const startTime = Date.now();

    this.options.onRequest?.({
      id: message.requestId,
      method: message.method,
      path: message.path,
      startTime,
    });

    try {
      const response = await this.localProxy.forward(
        message.method,
        message.path,
        message.headers,
        message.body
      );

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      if (this.ws?.readyState !== WebSocket.OPEN) {
        const duration = Date.now() - startTime;
        console.error(`[ws] Cannot send response - WebSocket state: ${this.ws?.readyState}`);
        this.options.onResponse?.(message.requestId, 502, duration, true);
        return;
      }

      // Get body as ArrayBuffer for proper binary handling
      const bodyBuffer = await response.arrayBuffer();
      let bodyBytes = new Uint8Array(bodyBuffer);

      // Compress if beneficial (not already compressed, compressible type, large enough, not 304)
      const contentEncoding = responseHeaders["content-encoding"];
      const contentType = responseHeaders["content-type"] || "";
      const acceptEncoding = message.headers["accept-encoding"] || "";

      if (
        response.status !== 304 &&
        !contentEncoding &&
        bodyBytes.length >= TunnelClient.COMPRESS_THRESHOLD &&
        this.isCompressible(contentType)
      ) {
        const compressed = await this.compressBody(bodyBytes, acceptEncoding);
        if (compressed) {
          bodyBytes = compressed.data;
          responseHeaders["content-encoding"] = compressed.encoding;
          responseHeaders["content-length"] = String(bodyBytes.length);
        }
      }

      if (bodyBytes.length < TunnelClient.STREAM_THRESHOLD) {
        // Small response - send as single message
        const clientMessage: ClientMessage = {
          type: "http_response",
          requestId: message.requestId,
          status: response.status,
          headers: responseHeaders,
          body: new TextDecoder().decode(bodyBytes),
        };
        this.ws.send(JSON.stringify(clientMessage));
      } else {
        // Large response - stream in chunks
        await this.sendStreamingResponse(message.requestId, response.status, responseHeaders, bodyBytes);
      }

      // Duration includes everything: fetch + compress + send
      const duration = Date.now() - startTime;
      this.options.onResponse?.(message.requestId, response.status, duration, false);
    } catch (error) {
      this.sendErrorResponse(message.requestId, startTime, error);
    }
  }

  private isCompressible(contentType: string): boolean {
    const compressibleTypes = [
      "text/",
      "application/json",
      "application/javascript",
      "application/xml",
      "application/xhtml",
      "image/svg",
    ];
    return compressibleTypes.some((t) => contentType.includes(t));
  }

  private async compressBody(
    data: Uint8Array<ArrayBuffer>,
    acceptEncoding: string
  ): Promise<{ data: Uint8Array<ArrayBuffer>; encoding: string } | null> {
    // Prefer zstd (fastest), then br (best ratio), then gzip (universal)
    try {
      if (acceptEncoding.includes("zstd")) {
        const compressed = Bun.zstdCompressSync(data, { level: 3 });
        return { data: new Uint8Array(compressed) as Uint8Array<ArrayBuffer>, encoding: "zstd" };
      }

      if (acceptEncoding.includes("br")) {
        // Use CompressionStream for brotli
        const stream = new CompressionStream("brotli" as CompressionFormat);
        const writer = stream.writable.getWriter();
        writer.write(new Uint8Array(data.buffer.slice(0)));
        writer.close();
        const compressed = await new Response(stream.readable).arrayBuffer();
        return { data: new Uint8Array(compressed), encoding: "br" };
      }

      if (acceptEncoding.includes("gzip")) {
        const compressed = Bun.gzipSync(data, { level: 6 });
        return { data: new Uint8Array(compressed) as Uint8Array<ArrayBuffer>, encoding: "gzip" };
      }
    } catch (e) {
      console.error("[compress] Failed:", e);
    }

    return null;
  }

  private async sendStreamingResponse(
    requestId: string,
    status: number,
    headers: Record<string, string>,
    body: Uint8Array
  ): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }

    // Send start message
    const startMessage: ClientMessage = {
      type: "http_response_start",
      requestId,
      status,
      headers,
    };
    this.ws.send(JSON.stringify(startMessage));

    // Send body in chunks
    for (let offset = 0; offset < body.length; offset += TunnelClient.CHUNK_SIZE) {
      const chunk = body.slice(offset, offset + TunnelClient.CHUNK_SIZE);
      // Convert to base64
      const base64 = btoa(String.fromCharCode(...chunk));

      const chunkMessage: ClientMessage = {
        type: "http_response_chunk",
        requestId,
        chunk: base64,
      };
      this.ws.send(JSON.stringify(chunkMessage));

      // Small delay to avoid overwhelming the WebSocket buffer
      if (offset + TunnelClient.CHUNK_SIZE < body.length) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }

    // Send end message
    const endMessage: ClientMessage = {
      type: "http_response_end",
      requestId,
    };
    this.ws.send(JSON.stringify(endMessage));
  }

  private sendErrorResponse(requestId: string, startTime: number, error: unknown): void {
    const duration = Date.now() - startTime;

    const clientMessage: ClientMessage = {
      type: "http_response",
      requestId,
      status: 502,
      headers: { "content-type": "text/plain" },
      body: `Bad Gateway: ${error instanceof Error ? error.message : "Unknown error"}`,
    };

    this.ws?.send(JSON.stringify(clientMessage));
    this.options.onResponse?.(requestId, 502, duration, true);
  }

  private sendPong(): void {
    const message: ClientMessage = { type: "pong" };
    this.ws?.send(JSON.stringify(message));
  }

  private startPingInterval(): void {
    // Send ping every 30 seconds to keep connection alive
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendPong();
      }
    }, 30000);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.options.onError?.("Max reconnect attempts reached");
      process.exit(1);
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    setTimeout(() => {
      this.connect().catch((error) => {
        this.options.onError?.(`Reconnect failed: ${error}`);
      });
    }, delay);
  }
}
