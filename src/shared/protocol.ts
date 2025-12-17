// WebSocket protocol messages between server and CLI

// Server -> Client messages
export type ServerMessage =
  | { type: "connected"; subdomain: string; publicUrl: string }
  | {
      type: "http_request";
      requestId: string;
      method: string;
      path: string;
      headers: Record<string, string>;
      body?: string;
    }
  | { type: "ping" }
  | { type: "error"; message: string };

// Client -> Server messages
export type ClientMessage =
  | {
      // Small text response - body inline
      type: "http_response";
      requestId: string;
      status: number;
      headers: Record<string, string>;
      body: string;
    }
  | {
      // Binary response header - body follows as binary WebSocket frame
      type: "http_response_binary";
      requestId: string;
      status: number;
      headers: Record<string, string>;
      bodySize: number;
    }
  | {
      // Stream start - headers and optional total size, chunks follow
      type: "http_response_stream_start";
      requestId: string;
      status: number;
      headers: Record<string, string>;
      totalSize?: number; // If known from content-length
    }
  | {
      // Stream chunk header - binary frame with chunk data follows
      type: "http_response_stream_chunk";
      requestId: string;
      chunkSize: number;
    }
  | {
      // Stream end
      type: "http_response_stream_end";
      requestId: string;
    }
  | {
      // Stream error
      type: "http_response_stream_error";
      requestId: string;
      error: string;
    }
  | { type: "pong" };

// Type guards
export function isServerMessage(msg: unknown): msg is ServerMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    typeof (msg as ServerMessage).type === "string"
  );
}

export function isClientMessage(msg: unknown): msg is ClientMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    typeof (msg as ClientMessage).type === "string"
  );
}
