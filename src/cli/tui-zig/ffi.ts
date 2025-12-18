/**
 * Bun FFI bindings for Zig TUI library
 * Shared memory communication with Zig thread for zero-copy rendering
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { dlopen, FFIType } from "bun:ffi";

import type { RequestInfo } from "../../shared/types.ts";

// Determine library path based on platform
function getLibPath(): string {
  const arch = process.arch; // arm64, x64
  const platform = process.platform; // darwin, linux

  let libName: string;
  let platformDir: string;

  if (platform === "darwin") {
    libName = "libtui.dylib";
    platformDir = arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  } else if (platform === "linux") {
    libName = "libtui.so";
    platformDir = "linux-x64";
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  // Try platform-specific prebuilt first
  const prebuiltPath = join(import.meta.dir, "lib", platformDir, libName);
  if (existsSync(prebuiltPath)) {
    return prebuiltPath;
  }

  // Fallback to zig-out (dev mode)
  const devPath = join(import.meta.dir, "zig-out/lib", libName);
  if (existsSync(devPath)) {
    return devPath;
  }

  throw new Error(
    `Native TUI library not found. Expected at:\n  ${prebuiltPath}\n  ${devPath}\n` +
    `Run 'zig build' in src/cli/tui-zig/ or use terminal-kit TUI instead.`
  );
}

// Constants must match main.zig
const MAX_REQUESTS = 100;
const MAX_URL_LEN = 256;
const MAX_PATH_LEN = 512;
const MAX_METHOD_LEN = 16;
const MAX_ERROR_LEN = 256;

// Connection types
const CONN_HTTP = 0;
const CONN_WS = 1;
const CONN_SSE = 2;

// Load the dynamic library
const lib = dlopen(getLibPath(), {
  tui_init: {
    args: [FFIType.ptr],
    returns: FFIType.bool,
  },
  tui_shutdown: {
    args: [],
    returns: FFIType.void,
  },
  tui_is_running: {
    args: [],
    returns: FFIType.bool,
  },
  tui_state_size: {
    args: [],
    returns: FFIType.u64,
  },
  tui_request_size: {
    args: [],
    returns: FFIType.u64,
  },
  // Request offsets
  req_offset_id: { args: [], returns: FFIType.u64 },
  req_offset_method: { args: [], returns: FFIType.u64 },
  req_offset_method_len: { args: [], returns: FFIType.u64 },
  req_offset_path: { args: [], returns: FFIType.u64 },
  req_offset_path_len: { args: [], returns: FFIType.u64 },
  req_offset_status: { args: [], returns: FFIType.u64 },
  req_offset_duration: { args: [], returns: FFIType.u64 },
  req_offset_is_error: { args: [], returns: FFIType.u64 },
  req_offset_is_local: { args: [], returns: FFIType.u64 },
  req_offset_conn_type: { args: [], returns: FFIType.u64 },
  // State offsets
  state_offset_connected: { args: [], returns: FFIType.u64 },
  state_offset_reconnecting: { args: [], returns: FFIType.u64 },
  state_offset_reconnect_attempt: { args: [], returns: FFIType.u64 },
  state_offset_public_url: { args: [], returns: FFIType.u64 },
  state_offset_public_url_len: { args: [], returns: FFIType.u64 },
  state_offset_local_port: { args: [], returns: FFIType.u64 },
  state_offset_error_message: { args: [], returns: FFIType.u64 },
  state_offset_error_len: { args: [], returns: FFIType.u64 },
  state_offset_requests: { args: [], returns: FFIType.u64 },
  state_offset_request_count: { args: [], returns: FFIType.u64 },
  state_offset_request_head: { args: [], returns: FFIType.u64 },
  state_offset_stats_total: { args: [], returns: FFIType.u64 },
  state_offset_stats_2xx: { args: [], returns: FFIType.u64 },
  state_offset_stats_4xx: { args: [], returns: FFIType.u64 },
  state_offset_stats_5xx: { args: [], returns: FFIType.u64 },
  state_offset_stats_avg_ms: { args: [], returns: FFIType.u64 },
  state_offset_version: { args: [], returns: FFIType.u64 },
});

// Get struct sizes and offsets from Zig
const STATE_SIZE = Number(lib.symbols.tui_state_size());
const REQUEST_SIZE = Number(lib.symbols.tui_request_size());

// Request field offsets (from Zig)
const REQ = {
  id: Number(lib.symbols.req_offset_id()),
  method: Number(lib.symbols.req_offset_method()),
  method_len: Number(lib.symbols.req_offset_method_len()),
  path: Number(lib.symbols.req_offset_path()),
  path_len: Number(lib.symbols.req_offset_path_len()),
  status: Number(lib.symbols.req_offset_status()),
  duration: Number(lib.symbols.req_offset_duration()),
  is_error: Number(lib.symbols.req_offset_is_error()),
  is_local: Number(lib.symbols.req_offset_is_local()),
  conn_type: Number(lib.symbols.req_offset_conn_type()),
};

// State field offsets (from Zig)
const STATE = {
  connected: Number(lib.symbols.state_offset_connected()),
  reconnecting: Number(lib.symbols.state_offset_reconnecting()),
  reconnect_attempt: Number(lib.symbols.state_offset_reconnect_attempt()),
  public_url: Number(lib.symbols.state_offset_public_url()),
  public_url_len: Number(lib.symbols.state_offset_public_url_len()),
  local_port: Number(lib.symbols.state_offset_local_port()),
  error_message: Number(lib.symbols.state_offset_error_message()),
  error_len: Number(lib.symbols.state_offset_error_len()),
  requests: Number(lib.symbols.state_offset_requests()),
  request_count: Number(lib.symbols.state_offset_request_count()),
  request_head: Number(lib.symbols.state_offset_request_head()),
  stats_total: Number(lib.symbols.state_offset_stats_total()),
  stats_2xx: Number(lib.symbols.state_offset_stats_2xx()),
  stats_4xx: Number(lib.symbols.state_offset_stats_4xx()),
  stats_5xx: Number(lib.symbols.state_offset_stats_5xx()),
  stats_avg_ms: Number(lib.symbols.state_offset_stats_avg_ms()),
  version: Number(lib.symbols.state_offset_version()),
};

export class ZigTUI {
  private stateBuffer: ArrayBuffer;
  private stateView: DataView;
  private stateU8: Uint8Array;
  private localPort: number;
  private requestsMap = new Map<string, { index: number; zigId: number }>();
  private nextRequestId = 1;

  constructor(localPort: number) {
    this.localPort = localPort;

    // Allocate state buffer
    this.stateBuffer = new ArrayBuffer(STATE_SIZE);
    this.stateView = new DataView(this.stateBuffer);
    this.stateU8 = new Uint8Array(this.stateBuffer);

    // Zero-initialize
    this.stateU8.fill(0);

    // Set local port
    this.setLocalPort(localPort);
  }

  start(): void {
    // Pass Uint8Array directly - Bun FFI handles pointer conversion
    const success = lib.symbols.tui_init(this.stateU8);
    if (!success) {
      throw new Error("Failed to initialize TUI");
    }

    // Register cleanup handlers
    const cleanup = () => {
      this.destroy();
    };

    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      cleanup();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });
  }

  destroy(): void {
    if (lib.symbols.tui_is_running()) {
      lib.symbols.tui_shutdown();
    }
  }

  private setLocalPort(port: number): void {
    this.stateView.setUint16(STATE.local_port, port, true);
  }

  private incrementVersion(): void {
    const current = this.stateView.getUint32(STATE.version, true);
    this.stateView.setUint32(STATE.version, current + 1, true);
  }

  setConnected(_subdomain: string, publicUrl: string): void {
    // Set connected flag
    this.stateU8[STATE.connected] = 1;
    this.stateU8[STATE.reconnecting] = 0;

    // Set public URL
    const urlBytes = new TextEncoder().encode(publicUrl);
    const urlLen = Math.min(urlBytes.length, MAX_URL_LEN);
    this.stateU8.set(urlBytes.subarray(0, urlLen), STATE.public_url);
    this.stateView.setUint16(STATE.public_url_len, urlLen, true);

    // Clear error
    this.stateView.setUint16(STATE.error_len, 0, true);

    this.incrementVersion();
  }

  setDisconnected(): void {
    this.stateU8[STATE.connected] = 0;
    this.stateU8[STATE.reconnecting] = 0;
    this.incrementVersion();
  }

  setReconnecting(attempt: number, _delayMs: number): void {
    this.stateU8[STATE.connected] = 0;
    this.stateU8[STATE.reconnecting] = 1;
    this.stateU8[STATE.reconnect_attempt] = attempt;
    this.incrementVersion();
  }

  setError(message: string): void {
    const msgBytes = new TextEncoder().encode(message);
    const msgLen = Math.min(msgBytes.length, MAX_ERROR_LEN);
    this.stateU8.set(msgBytes.subarray(0, msgLen), STATE.error_message);
    this.stateView.setUint16(STATE.error_len, msgLen, true);
    this.incrementVersion();
  }

  addRequest(req: RequestInfo): void {
    const zigId = this.nextRequestId++;
    const head = this.stateView.getUint32(STATE.request_head, true);
    const count = this.stateView.getUint32(STATE.request_count, true);

    // Calculate request offset
    const reqOffset = STATE.requests + head * REQUEST_SIZE;

    // Zero the request slot
    this.stateU8.fill(0, reqOffset, reqOffset + REQUEST_SIZE);

    // Write request data using Zig offsets
    // id: u64
    this.stateView.setBigUint64(reqOffset + REQ.id, BigInt(zigId), true);

    // method: [16]u8
    const methodBytes = new TextEncoder().encode(req.method);
    const methodLen = Math.min(methodBytes.length, MAX_METHOD_LEN);
    this.stateU8.set(methodBytes.subarray(0, methodLen), reqOffset + REQ.method);

    // method_len: u8
    this.stateU8[reqOffset + REQ.method_len] = methodLen;

    // path: [512]u8
    const pathBytes = new TextEncoder().encode(req.path);
    const pathLen = Math.min(pathBytes.length, MAX_PATH_LEN);
    this.stateU8.set(pathBytes.subarray(0, pathLen), reqOffset + REQ.path);

    // path_len: u16
    this.stateView.setUint16(reqOffset + REQ.path_len, pathLen, true);

    // status: u16 (0 = pending)
    this.stateView.setUint16(reqOffset + REQ.status, 0, true);

    // duration_ms: u32
    this.stateView.setUint32(reqOffset + REQ.duration, 0, true);

    // is_error: bool
    this.stateU8[reqOffset + REQ.is_error] = 0;

    // is_local: bool
    this.stateU8[reqOffset + REQ.is_local] = 0;

    // connection_type: u8
    const connType = req.connectionType === 'ws' ? CONN_WS :
                     req.connectionType === 'sse' ? CONN_SSE : CONN_HTTP;
    this.stateU8[reqOffset + REQ.conn_type] = connType;

    // Update head and count
    const newHead = (head + 1) % MAX_REQUESTS;
    this.stateView.setUint32(STATE.request_head, newHead, true);
    if (count < MAX_REQUESTS) {
      this.stateView.setUint32(STATE.request_count, count + 1, true);
    }

    // Update stats
    const total = this.stateView.getUint32(STATE.stats_total, true);
    this.stateView.setUint32(STATE.stats_total, total + 1, true);

    // Track mapping
    this.requestsMap.set(req.id, { index: head, zigId });

    this.incrementVersion();
  }

  addLocalRequest(method: string, path: string): void {
    const id = crypto.randomUUID();
    this.addRequest({
      id,
      method,
      path,
      startTime: Date.now(),
      connectionType: "http",
    });
    // Mark as local
    const mapping = this.requestsMap.get(id);
    if (mapping) {
      const reqOffset = STATE.requests + mapping.index * REQUEST_SIZE;
      this.stateU8[reqOffset + REQ.is_local] = 1;
      this.stateView.setUint16(reqOffset + REQ.status, 200, true);
    }
  }

  updateRequest(id: string, status: number, duration: number, error?: boolean): void {
    const mapping = this.requestsMap.get(id);
    if (!mapping) return;

    const reqOffset = STATE.requests + mapping.index * REQUEST_SIZE;

    // status: u16
    this.stateView.setUint16(reqOffset + REQ.status, status, true);

    // duration_ms: u32
    this.stateView.setUint32(reqOffset + REQ.duration, duration, true);

    // is_error: bool
    this.stateU8[reqOffset + REQ.is_error] = error ? 1 : 0;

    // Update stats
    if (status >= 200 && status < 300) {
      const s2xx = this.stateView.getUint32(STATE.stats_2xx, true);
      this.stateView.setUint32(STATE.stats_2xx, s2xx + 1, true);
    } else if (status >= 400 && status < 500) {
      const s4xx = this.stateView.getUint32(STATE.stats_4xx, true);
      this.stateView.setUint32(STATE.stats_4xx, s4xx + 1, true);
    } else if (status >= 500) {
      const s5xx = this.stateView.getUint32(STATE.stats_5xx, true);
      this.stateView.setUint32(STATE.stats_5xx, s5xx + 1, true);
    }

    // Update average (simple moving average)
    const total = this.stateView.getUint32(STATE.stats_total, true);
    const currentAvg = this.stateView.getUint32(STATE.stats_avg_ms, true);
    const newAvg = total > 0 ? Math.round((currentAvg * (total - 1) + duration) / total) : duration;
    this.stateView.setUint32(STATE.stats_avg_ms, newAvg, true);

    this.incrementVersion();
  }

  updateActivity(_id: string, _direction: 'in' | 'out'): void {
    // Activity arrows are rendered based on time - just trigger version bump
    this.incrementVersion();
  }

  updateProgress(_id: string, _bytesTransferred: number, _totalBytes?: number): void {
    // Progress tracking not implemented in Zig TUI yet
    this.incrementVersion();
  }

  updateTiming(id: string, duration: number): void {
    const mapping = this.requestsMap.get(id);
    if (!mapping) return;

    const reqOffset = STATE.requests + mapping.index * REQUEST_SIZE;
    this.stateView.setUint32(reqOffset + REQ.duration, duration, true);
    this.incrementVersion();
  }

  setRequestError(id: string, _message: string, duration: number): void {
    const mapping = this.requestsMap.get(id);
    if (!mapping) return;

    const reqOffset = STATE.requests + mapping.index * REQUEST_SIZE;
    this.stateU8[reqOffset + REQ.is_error] = 1;
    this.stateView.setUint32(reqOffset + REQ.duration, duration, true);
    this.incrementVersion();
  }
}

// Export for debugging
export const DEBUG = {
  STATE_SIZE,
  REQUEST_SIZE,
  STATE,
  REQ,
};
