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

      this.ws.addEventListener("close", () => {
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

      const responseBody = await response.text();
      const duration = Date.now() - startTime;

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const clientMessage: ClientMessage = {
        type: "http_response",
        requestId: message.requestId,
        status: response.status,
        headers,
        body: responseBody,
      };

      this.ws?.send(JSON.stringify(clientMessage));

      this.options.onResponse?.(
        message.requestId,
        response.status,
        duration,
        false
      );
    } catch (error) {
      const duration = Date.now() - startTime;

      const clientMessage: ClientMessage = {
        type: "http_response",
        requestId: message.requestId,
        status: 502,
        headers: { "content-type": "text/plain" },
        body: `Bad Gateway: ${error instanceof Error ? error.message : "Unknown error"}`,
      };

      this.ws?.send(JSON.stringify(clientMessage));

      this.options.onResponse?.(
        message.requestId,
        502,
        duration,
        true
      );
    }
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
