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
