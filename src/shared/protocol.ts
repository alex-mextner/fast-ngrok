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
      type: "http_response";
      requestId: string;
      status: number;
      headers: Record<string, string>;
      body: string;
    }
  | {
      // Streaming response - start
      type: "http_response_start";
      requestId: string;
      status: number;
      headers: Record<string, string>;
    }
  | {
      // Streaming response - body chunk (base64 encoded)
      type: "http_response_chunk";
      requestId: string;
      chunk: string; // base64
    }
  | {
      // Streaming response - end
      type: "http_response_end";
      requestId: string;
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
