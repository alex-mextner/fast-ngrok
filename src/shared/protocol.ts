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
  | {
      // Sent after server completes HTTP response to browser
      type: "request_timing";
      requestId: string;
      duration: number; // Real end-to-end time measured on server
    }
  | { type: "ping" }
  | { type: "error"; message: string }
  // WebSocket passthrough: server tells client to open WS to localhost
  | {
      type: "ws_open";
      wsId: string;
      path: string;
      headers: Record<string, string>;
      protocol?: string; // Sec-WebSocket-Protocol
    }
  // WebSocket passthrough: server forwards message from browser to client
  | {
      type: "ws_message";
      wsId: string;
      data: string; // For text frames
      isBinary?: false;
    }
  | {
      type: "ws_message_binary";
      wsId: string;
      // Binary data follows as next WebSocket frame
    }
  // WebSocket passthrough: server tells client that browser closed WS
  | {
      type: "ws_close";
      wsId: string;
      code?: number;
      reason?: string;
    };

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
  | { type: "pong" }
  // WebSocket passthrough: client confirms WS opened to localhost
  | {
      type: "ws_opened";
      wsId: string;
      protocol?: string; // Selected Sec-WebSocket-Protocol
    }
  // WebSocket passthrough: client reports WS open failed
  | {
      type: "ws_error";
      wsId: string;
      error: string;
    }
  // WebSocket passthrough: client forwards message from localhost to browser
  | {
      type: "ws_message";
      wsId: string;
      data: string; // For text frames
      isBinary?: false;
    }
  | {
      type: "ws_message_binary";
      wsId: string;
      // Binary data follows as next WebSocket frame
    }
  // WebSocket passthrough: client tells server that localhost WS closed
  | {
      type: "ws_close";
      wsId: string;
      code?: number;
      reason?: string;
    };

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
