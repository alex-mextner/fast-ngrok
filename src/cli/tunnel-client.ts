import type { ServerMessage, ClientMessage } from "../shared/protocol.ts";
import type { RequestInfo } from "../shared/types.ts";
import { LocalProxy } from "./local-proxy.ts";

export interface TunnelClientOptions {
  serverUrl: string;
  apiKey: string;
  localPort: number;
  subdomain?: string; // Custom subdomain (optional)
  onRequest?: (req: RequestInfo) => void;
  // duration = time spent on CLI side (local fetch + compress + send)
  onResponse?: (id: string, status: number, duration: number, error?: boolean) => void;
  // Real end-to-end duration measured on server (arrives after onResponse)
  onTiming?: (id: string, duration: number) => void;
  onActivity?: (id: string, direction: 'in' | 'out') => void;
  onProgress?: (id: string, bytesTransferred: number, totalBytes?: number) => void;
  onRequestError?: (id: string, message: string, duration: number) => void;
  onConnect?: (subdomain: string, publicUrl: string) => void;
  onDisconnect?: () => void;
  onError?: (message: string) => void;
  onReconnecting?: (attempt: number, delayMs: number) => void;
}

export class TunnelClient {
  private ws: WebSocket | null = null;
  private localProxy: LocalProxy;
  private reconnectAttempts = 0;
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

      // Build URL with port and optional subdomain parameter
      const params = new URLSearchParams();
      params.set("port", String(this.options.localPort));
      if (this.currentSubdomain) {
        params.set("subdomain", this.currentSubdomain);
      }
      const connectUrl = `${wsUrl}/__tunnel__/connect?${params.toString()}`;

      // Bun's WebSocket constructor accepts headers in second argument
      this.ws = new WebSocket(connectUrl, {
        headers: {
          "x-api-key": this.options.apiKey,
        },
      } as unknown as string | string[]);

      this.ws.addEventListener("open", () => {
        this.hasConnectedOnce = true; // Enable reconnect after first successful connection
        this.reconnectAttempts = 0;
        this.startPingInterval();
        resolve();
      });

      this.ws.addEventListener("message", async (event) => {
        try {
          await this.handleMessage(event.data.toString());
        } catch (error) {
          console.error("[ws] Message handling error:", error);
        }
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
          this.options.onConnect?.(message.subdomain, message.publicUrl);
          break;

        case "http_request":
          await this.handleRequest(message);
          break;

        case "request_timing":
          // Server sends real end-to-end duration after response completes
          this.options.onTiming?.(message.requestId, message.duration);
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

  // Threshold for binary transfer (64KB)
  private static BINARY_THRESHOLD = 64 * 1024;
  // Threshold for streaming (256KB) - larger responses stream in chunks
  private static STREAM_THRESHOLD = 256 * 1024;
  // Threshold for large files (100MB) - above this, stream without buffering/compression
  private static LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;
  // Minimum size to compress (1KB)
  private static COMPRESS_THRESHOLD = 1024;

  // SSE detection helpers
  private isSSE(contentType: string, headers: Record<string, string>): boolean {
    // Primary: Content-Type header
    if (contentType.includes("text/event-stream")) return true;
    // Secondary: X-Accel-Buffering: no (nginx-style hint)
    if (headers["x-accel-buffering"]?.toLowerCase() === "no") return true;
    return false;
  }

  private async handleRequest(message: Extract<ServerMessage, { type: "http_request" }>): Promise<void> {
    const startTime = Date.now();
    const connectionType = this.detectConnectionType(message.headers, message.path);

    this.options.onRequest?.({
      id: message.requestId,
      method: message.method,
      path: message.path,
      startTime,
      connectionType,
    });

    // Signal incoming data for WS/SSE activity indicator
    this.options.onActivity?.(message.requestId, 'in');

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

      // Proxy-level ETag validation
      // Dev servers (Bun, Vite) don't implement conditional GET, so we do it ourselves
      const ifNoneMatch = message.headers["if-none-match"];
      const responseEtag = response.headers.get("etag");
      if (ifNoneMatch && responseEtag && response.status === 200) {
        // Normalize ETags for comparison (remove weak validator prefix if present)
        const normalizeEtag = (etag: string) => etag.replace(/^W\//, "").trim();
        if (normalizeEtag(ifNoneMatch) === normalizeEtag(responseEtag)) {
          // ETags match - return 304 Not Modified
          const duration = Date.now() - startTime;

          // Only send cache-related headers
          const notModifiedHeaders: Record<string, string> = { etag: responseEtag };
          const cacheControl = response.headers.get("cache-control");
          if (cacheControl) notModifiedHeaders["cache-control"] = cacheControl;
          const vary = response.headers.get("vary");
          if (vary) notModifiedHeaders.vary = vary;

          const notModifiedMsg: ClientMessage = {
            type: "http_response",
            requestId: message.requestId,
            status: 304,
            headers: notModifiedHeaders,
            body: "",
          };
          this.ws?.send(JSON.stringify(notModifiedMsg));
          this.options.onResponse?.(message.requestId, 304, duration, false);
          return;
        }
      }

      // Check content-length to decide streaming vs buffering
      const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
      const contentEncoding = response.headers.get("content-encoding");
      const contentType = responseHeaders["content-type"] || "";
      const acceptEncoding = message.headers["accept-encoding"] || "";

      // Determine response handling mode:
      // - Small (<=256KB): buffer + compress + send
      // - Medium (256KB-10MB): buffer + compress + stream in chunks
      // - Large (>10MB): stream raw without buffering
      const isSmall = contentLength <= TunnelClient.STREAM_THRESHOLD;
      const isLarge = contentLength > TunnelClient.LARGE_FILE_THRESHOLD;

      // Remove encoding headers for small/medium responses (we handle compression)
      // Bun fetch auto-decompresses, so content-encoding header is stale
      // For large files and 304, keep original headers
      if (!isLarge && response.status !== 304) {
        delete responseHeaders["content-encoding"];
        delete responseHeaders["content-length"];
        delete responseHeaders["transfer-encoding"];
      }

      if (this.ws?.readyState !== WebSocket.OPEN) {
        const duration = Date.now() - startTime;
        this.options.onRequestError?.(message.requestId, "WebSocket disconnected", duration);
        this.options.onResponse?.(message.requestId, 502, duration, true);
        return;
      }

      // SSE: stream immediately without buffering (ignore content-length)
      if (this.isSSE(contentType, responseHeaders)) {
        await this.streamSSE(message.requestId, response, responseHeaders, startTime);
      } else if (isSmall) {
        // Small response - buffer and optionally compress
        await this.sendBufferedResponse(message, response, responseHeaders, startTime);
      } else if (isLarge) {
        // Very large response - stream without buffering (original behavior)
        await this.streamResponse(message.requestId, response, responseHeaders, contentLength, startTime);
      } else {
        // Medium response (256KB-10MB) - buffer, compress, then stream
        await this.sendCompressedStream(
          message.requestId,
          response,
          responseHeaders,
          contentType,
          acceptEncoding,
          contentEncoding,
          startTime
        );
      }
    } catch (error) {
      this.sendErrorResponse(message.requestId, startTime, error);
    }
  }

  private async streamResponse(
    requestId: string,
    response: Response,
    headers: Record<string, string>,
    totalSize: number,
    startTime: number
  ): Promise<void> {
    // Send stream start
    const startMsg: ClientMessage = {
      type: "http_response_stream_start",
      requestId,
      status: response.status,
      headers,
      totalSize: totalSize || undefined,
    };
    this.ws!.send(JSON.stringify(startMsg));

    // Report initial progress
    this.options.onProgress?.(requestId, 0, totalSize || undefined);

    const reader = response.body?.getReader();
    if (!reader) {
      // No body - end stream immediately
      const endMsg: ClientMessage = { type: "http_response_stream_end", requestId };
      this.ws!.send(JSON.stringify(endMsg));
      const duration = Date.now() - startTime;
      this.options.onResponse?.(requestId, response.status, duration, false);
      return;
    }

    let bytesTransferred = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (this.ws?.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket disconnected during streaming");
        }

        // Send chunk header + binary data
        const chunkMsg: ClientMessage = {
          type: "http_response_stream_chunk",
          requestId,
          chunkSize: value.length,
        };
        this.ws.send(JSON.stringify(chunkMsg));
        this.ws.send(value);

        bytesTransferred += value.length;
        this.options.onProgress?.(requestId, bytesTransferred, totalSize || undefined);
        this.options.onActivity?.(requestId, 'out');
      }

      // Send stream end
      const endMsg: ClientMessage = { type: "http_response_stream_end", requestId };
      this.ws!.send(JSON.stringify(endMsg));

      const duration = Date.now() - startTime;
      this.options.onResponse?.(requestId, response.status, duration, false);
    } catch (error) {
      // Stream error
      const errMsg = error instanceof Error ? error.message : "Stream error";
      const errorMsgProto: ClientMessage = {
        type: "http_response_stream_error",
        requestId,
        error: errMsg,
      };
      this.ws?.send(JSON.stringify(errorMsgProto));

      const duration = Date.now() - startTime;
      this.options.onRequestError?.(requestId, errMsg, duration);
      this.options.onResponse?.(requestId, 502, duration, true);
    } finally {
      reader.releaseLock();
    }
  }

  // SSE streaming - stream data immediately without buffering
  // Unlike regular streaming, SSE has no known size and may run for hours
  private async streamSSE(
    requestId: string,
    response: Response,
    headers: Record<string, string>,
    startTime: number
  ): Promise<void> {
    // Remove headers that don't apply to streaming
    delete headers["content-length"];
    delete headers["content-encoding"];
    delete headers["transfer-encoding"];

    // Send stream start (no totalSize - SSE is unbounded)
    const startMsg: ClientMessage = {
      type: "http_response_stream_start",
      requestId,
      status: response.status,
      headers,
    };
    this.ws!.send(JSON.stringify(startMsg));

    const reader = response.body?.getReader();
    if (!reader) {
      const endMsg: ClientMessage = { type: "http_response_stream_end", requestId };
      this.ws!.send(JSON.stringify(endMsg));
      const duration = Date.now() - startTime;
      this.options.onResponse?.(requestId, response.status, duration, false);
      return;
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (this.ws?.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket disconnected during SSE streaming");
        }

        // Send chunk immediately - no buffering for SSE
        const chunkMsg: ClientMessage = {
          type: "http_response_stream_chunk",
          requestId,
          chunkSize: value.length,
        };
        this.ws.send(JSON.stringify(chunkMsg));
        this.ws.send(value);

        // Activity indicator
        this.options.onActivity?.(requestId, 'out');
      }

      // Stream ended normally (server closed SSE connection)
      const endMsg: ClientMessage = { type: "http_response_stream_end", requestId };
      this.ws!.send(JSON.stringify(endMsg));

      const duration = Date.now() - startTime;
      this.options.onResponse?.(requestId, response.status, duration, false);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "SSE stream error";
      const errorMsgProto: ClientMessage = {
        type: "http_response_stream_error",
        requestId,
        error: errMsg,
      };
      this.ws?.send(JSON.stringify(errorMsgProto));

      const duration = Date.now() - startTime;
      this.options.onRequestError?.(requestId, errMsg, duration);
      this.options.onResponse?.(requestId, 502, duration, true);
    } finally {
      reader.releaseLock();
    }
  }

  // Medium-sized responses (256KB-10MB): buffer, compress, stream compressed data
  private async sendCompressedStream(
    requestId: string,
    response: Response,
    headers: Record<string, string>,
    contentType: string,
    acceptEncoding: string,
    _existingEncoding: string | null, // Unused: Bun fetch auto-decompresses
    startTime: number
  ): Promise<void> {
    // Buffer entire response
    const bodyBuffer = await response.arrayBuffer();
    let bodyBytes = new Uint8Array(bodyBuffer);

    // Compress if compressible type and not 304
    // Note: Bun fetch auto-decompresses, so we always compress ourselves
    if (response.status !== 304 && this.isCompressible(contentType)) {
      const compressed = await this.compressBody(bodyBytes, acceptEncoding);
      if (compressed) {
        bodyBytes = compressed.data;
        headers["content-encoding"] = compressed.encoding;
      }
    }

    // Update content-length to actual size
    headers["content-length"] = String(bodyBytes.length);

    // Send stream start
    const startMsg: ClientMessage = {
      type: "http_response_stream_start",
      requestId,
      status: response.status,
      headers,
      totalSize: bodyBytes.length,
    };
    this.ws!.send(JSON.stringify(startMsg));

    // Report initial progress
    this.options.onProgress?.(requestId, 0, bodyBytes.length);

    // Stream compressed data in 64KB chunks
    const CHUNK_SIZE = 64 * 1024;
    let offset = 0;

    try {
      while (offset < bodyBytes.length) {
        if (this.ws?.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket disconnected during streaming");
        }

        const chunk = bodyBytes.slice(offset, offset + CHUNK_SIZE);

        const chunkMsg: ClientMessage = {
          type: "http_response_stream_chunk",
          requestId,
          chunkSize: chunk.length,
        };
        this.ws.send(JSON.stringify(chunkMsg));
        this.ws.send(chunk);

        offset += chunk.length;
        this.options.onProgress?.(requestId, offset, bodyBytes.length);
        this.options.onActivity?.(requestId, 'out');
      }

      // Send stream end
      const endMsg: ClientMessage = { type: "http_response_stream_end", requestId };
      this.ws!.send(JSON.stringify(endMsg));

      const duration = Date.now() - startTime;
      this.options.onResponse?.(requestId, response.status, duration, false);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Stream error";
      const errorMsgProto: ClientMessage = {
        type: "http_response_stream_error",
        requestId,
        error: errMsg,
      };
      this.ws?.send(JSON.stringify(errorMsgProto));

      const duration = Date.now() - startTime;
      this.options.onRequestError?.(requestId, errMsg, duration);
      this.options.onResponse?.(requestId, 502, duration, true);
    }
  }

  private async sendBufferedResponse(
    message: Extract<ServerMessage, { type: "http_request" }>,
    response: Response,
    responseHeaders: Record<string, string>,
    startTime: number
  ): Promise<void> {
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

    // Use binary for: large responses OR compressed data
    const isCompressed = !!responseHeaders["content-encoding"];
    const needsBinary = bodyBytes.length >= TunnelClient.BINARY_THRESHOLD || isCompressed;

    // Signal outgoing data for WS/SSE activity indicator
    this.options.onActivity?.(message.requestId, 'out');

    try {
      if (!needsBinary) {
        // Small text response - body inline in JSON
        const clientMessage: ClientMessage = {
          type: "http_response",
          requestId: message.requestId,
          status: response.status,
          headers: responseHeaders,
          body: new TextDecoder().decode(bodyBytes),
        };
        this.ws!.send(JSON.stringify(clientMessage));
      } else {
        // Large/binary response - JSON header + binary frame
        const headerMessage: ClientMessage = {
          type: "http_response_binary",
          requestId: message.requestId,
          status: response.status,
          headers: responseHeaders,
          bodySize: bodyBytes.length,
        };
        this.ws!.send(JSON.stringify(headerMessage));
        this.ws!.send(bodyBytes);
      }
    } catch (sendError) {
      // WebSocket send failed (connection closed, buffer full, etc.)
      const duration = Date.now() - startTime;
      const errMsg = sendError instanceof Error ? sendError.message : "Send failed";
      this.options.onRequestError?.(message.requestId, errMsg, duration);
      this.options.onResponse?.(message.requestId, 502, duration, true);
      return;
    }

    // Duration includes everything: fetch + compress + send
    const duration = Date.now() - startTime;
    this.options.onResponse?.(message.requestId, response.status, duration, false);
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

  private detectConnectionType(headers: Record<string, string>, path: string): 'ws' | 'sse' | 'http' {
    const upgrade = headers['upgrade']?.toLowerCase();
    const accept = headers['accept']?.toLowerCase();

    if (upgrade === 'websocket') return 'ws';
    if (accept?.includes('text/event-stream')) return 'sse';
    if (path.includes('hmr') || path.includes('hot-update')) return 'ws';
    return 'http';
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
    // Infinite retry with exponential backoff, cap at 60s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
    this.reconnectAttempts++;

    // Notify about reconnect status
    this.options.onReconnecting?.(this.reconnectAttempts, delay);

    // Log every 10 attempts
    if (this.reconnectAttempts % 10 === 0) {
      this.options.onError?.(`Still trying to reconnect (attempt ${this.reconnectAttempts})...`);
    }

    setTimeout(() => {
      this.connect().catch((error) => {
        this.options.onError?.(`Reconnect failed: ${error}`);
        // Don't exit - close handler will trigger scheduleReconnect again
      });
    }, delay);
  }
}
