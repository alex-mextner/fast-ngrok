import terminalKit from "terminal-kit";
import type { RequestInfo } from "../../shared/types.ts";

interface RequestLog extends RequestInfo {
  status?: number;
  duration?: number; // CLI-side time (local fetch + compress + send)
  error?: boolean;
  errorMessage?: string;
  isLocal?: boolean; // Request went through local shortcut (bypassed tunnel)
  // Activity tracking for WS/SSE
  lastIncoming?: number;
  lastOutgoing?: number;
  // Streaming progress
  bytesTransferred?: number;
  totalBytes?: number;
}

// Incremental stats tracking
interface Stats {
  total: number;
  success: number;    // 2xx
  clientErr: number;  // 4xx
  serverErr: number;  // 5xx
  totalDuration: number;
  completedCount: number;
}

export class TUI {
  private requests: RequestLog[] = [];
  private requestsMap = new Map<string, RequestLog>(); // O(1) lookup by id
  private publicUrl: string | null = null;
  private connected = false;
  private errorMessage: string | null = null;
  private reconnecting: { attempt: number; delayMs: number } | null = null;
  private maxRequests = 100;
  private scrollOffset = 0;
  private renderInterval: Timer | null = null;
  // Lazy-initialized terminal - only created when start() is called
  // This prevents terminal capture during module import (before sudo prompts, etc.)
  private term: terminalKit.Terminal | null = null;
  // Render-on-change: only render when state changes
  private needsRender = false;
  // Incremental stats
  private stats: Stats = { total: 0, success: 0, clientErr: 0, serverErr: 0, totalDuration: 0, completedCount: 0 };
  // Throttle renders to max 10fps (100ms between renders)
  private lastRenderTime = 0;
  private renderThrottleMs = 100;
  private pendingRenderTimeout: Timer | null = null;
  // Full clear counter - do full clear every N renders to prevent terminal-kit memory buildup
  private renderCount = 0;
  private fullClearEvery = 100; // Full clear every 100 renders (~10 seconds at 10fps)

  constructor(private localPort: number) {}

  start(): void {
    // Initialize terminal only when TUI actually starts
    this.term = terminalKit.terminal;

    // Register cleanup handlers
    const cleanup = () => {
      if (this.term) {
        this.term.grabInput(false);
      }
      // Exit alternate screen buffer and show cursor
      process.stdout.write("\x1B[?1049l\x1B[?25h");
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

    // Switch to alternate screen buffer (prevents flickering, restores terminal on exit)
    process.stdout.write("\x1B[?1049h");
    this.term.hideCursor();

    // Handle terminal resize
    this.term.on("resize", () => {
      this.render();
    });

    // Handle keyboard input
    this.term.grabInput({ mouse: false });
    this.term.on("key", (key: string, _matches: string[], data: unknown) => {
      // Check for Ctrl+C - works regardless of keyboard layout
      const rawCode = (data as { code?: string })?.code;
      const isCtrlC = key === "CTRL_C" || rawCode === "\x03";
      if (isCtrlC || key === "q") {
        this.destroy();
        process.exit(0);
      }
      if (key === "UP" && this.scrollOffset > 0) {
        this.scrollOffset--;
        this.render();
      }
      if (key === "DOWN") {
        const maxScroll = Math.max(0, this.requests.length - this.getRequestListHeight());
        if (this.scrollOffset < maxScroll) {
          this.scrollOffset++;
          this.render();
        }
      }
    });

    this.render();

    // Periodic render for activity indicators and elapsed time
    // Only actually renders if needsRender flag is set
    this.renderInterval = setInterval(() => {
      // Always check for activity indicator decay (WS/SSE arrows)
      const hasActiveConnections = this.requests.some(
        r => (r.connectionType === 'ws' || r.connectionType === 'sse') && !r.status
      );
      if (hasActiveConnections || this.needsRender) {
        this.needsRender = false;
        this.render();
      }
    }, 1000);
  }

  private scheduleRender(): void {
    this.needsRender = true;
  }

  // Throttled render - max 10fps to prevent terminal overload
  private throttledRender(): void {
    const now = Date.now();
    const elapsed = now - this.lastRenderTime;

    if (elapsed >= this.renderThrottleMs) {
      // Enough time passed - render immediately
      this.lastRenderTime = now;
      this.doRender();
    } else if (!this.pendingRenderTimeout) {
      // Schedule render for later
      this.pendingRenderTimeout = setTimeout(() => {
        this.pendingRenderTimeout = null;
        this.lastRenderTime = Date.now();
        this.doRender();
      }, this.renderThrottleMs - elapsed);
    }
    // If timeout already pending, skip - it will render soon
  }

  // Immediate render (for critical state changes like connect/disconnect)
  private render(): void {
    if (this.pendingRenderTimeout) {
      clearTimeout(this.pendingRenderTimeout);
      this.pendingRenderTimeout = null;
    }
    this.lastRenderTime = Date.now();
    this.doRender();
  }

  destroy(): void {
    if (this.renderInterval) {
      clearInterval(this.renderInterval);
    }
    if (this.pendingRenderTimeout) {
      clearTimeout(this.pendingRenderTimeout);
    }
    if (this.term) {
      this.term.grabInput(false);
    }
    // Exit alternate screen buffer and show cursor
    process.stdout.write("\x1B[?1049l\x1B[?25h");
  }

  setConnected(_subdomain: string, publicUrl: string): void {
    this.publicUrl = publicUrl;
    this.connected = true;
    this.errorMessage = null;
    this.reconnecting = null;
    this.render(); // Immediate render for connection status
  }

  setDisconnected(): void {
    this.connected = false;
    this.render(); // Immediate render for connection status
  }

  setReconnecting(attempt: number, delayMs: number): void {
    this.reconnecting = { attempt, delayMs };
    this.render(); // Immediate render for connection status
  }

  setError(message: string): void {
    this.errorMessage = message;
    this.render(); // Immediate render for errors
  }

  addRequest(req: RequestInfo): void {
    const logEntry: RequestLog = { ...req };
    this.requests.unshift(logEntry);
    this.requestsMap.set(req.id, logEntry);

    // Update stats
    this.stats.total++;

    // Remove oldest if over limit
    if (this.requests.length > this.maxRequests) {
      const removed = this.requests.pop();
      if (removed) {
        this.requestsMap.delete(removed.id);
        // Adjust stats for removed request
        this.stats.total--;
        if (removed.status) {
          if (removed.status < 400) this.stats.success--;
          else if (removed.status < 500) this.stats.clientErr--;
          else this.stats.serverErr--;
        }
        if (removed.duration !== undefined) {
          this.stats.totalDuration -= removed.duration;
          this.stats.completedCount--;
        }
      }
    }

    // Auto-scroll to top for new requests
    this.scrollOffset = 0;
    this.throttledRender();
  }

  // Add request that went through local shortcut (bypassed tunnel)
  addLocalRequest(method: string, path: string): void {
    const id = crypto.randomUUID();
    const logEntry: RequestLog = {
      id,
      method,
      path,
      startTime: Date.now(),
      connectionType: "http",
      status: 200,
      duration: 0,
      isLocal: true,
    };
    this.requests.unshift(logEntry);
    this.requestsMap.set(id, logEntry);

    // Update stats (local requests are always 200)
    this.stats.total++;
    this.stats.success++;
    this.stats.completedCount++;

    if (this.requests.length > this.maxRequests) {
      const removed = this.requests.pop();
      if (removed) {
        this.requestsMap.delete(removed.id);
        this.stats.total--;
        if (removed.status) {
          if (removed.status < 400) this.stats.success--;
          else if (removed.status < 500) this.stats.clientErr--;
          else this.stats.serverErr--;
        }
        if (removed.duration !== undefined) {
          this.stats.totalDuration -= removed.duration;
          this.stats.completedCount--;
        }
      }
    }

    this.scrollOffset = 0;
    this.throttledRender();
  }

  updateRequest(id: string, status: number, duration: number, error?: boolean): void {
    const req = this.requestsMap.get(id);
    if (req) {
      // Update stats for status change
      if (!req.status && status) {
        if (status < 400) this.stats.success++;
        else if (status < 500) this.stats.clientErr++;
        else this.stats.serverErr++;
      }
      // Update duration stats
      if (req.duration === undefined && duration !== undefined) {
        this.stats.totalDuration += duration;
        this.stats.completedCount++;
      } else if (req.duration !== undefined && duration !== undefined) {
        this.stats.totalDuration += duration - req.duration;
      }

      req.status = status;
      req.duration = duration;
      req.error = error;
      this.throttledRender();
    }
  }

  updateActivity(id: string, direction: 'in' | 'out'): void {
    const req = this.requestsMap.get(id);
    if (req) {
      const now = Date.now();
      if (direction === 'in') req.lastIncoming = now;
      else req.lastOutgoing = now;
      this.scheduleRender(); // Batch activity updates
    }
  }

  updateProgress(id: string, bytesTransferred: number, totalBytes?: number): void {
    const req = this.requestsMap.get(id);
    if (req) {
      req.bytesTransferred = bytesTransferred;
      if (totalBytes !== undefined) req.totalBytes = totalBytes;
      this.scheduleRender(); // Batch progress updates
    }
  }

  // Update with real end-to-end duration from server
  updateTiming(id: string, duration: number): void {
    const req = this.requestsMap.get(id);
    if (req) {
      // Update duration stats
      if (req.duration !== undefined) {
        this.stats.totalDuration += duration - req.duration;
      } else {
        this.stats.totalDuration += duration;
        this.stats.completedCount++;
      }
      req.duration = duration;
      this.scheduleRender(); // Batch timing updates
    }
  }

  setRequestError(id: string, message: string, duration: number): void {
    const req = this.requestsMap.get(id);
    if (req) {
      req.error = true;
      req.errorMessage = message;
      // Update duration stats
      if (req.duration === undefined) {
        this.stats.totalDuration += duration;
        this.stats.completedCount++;
      } else {
        this.stats.totalDuration += duration - req.duration;
      }
      req.duration = duration;
      this.throttledRender();
    }
  }

  private getRequestListHeight(): number {
    if (!this.term) return 10;
    return Math.max(1, this.term.height - 7); // Header (4 lines) + Footer (2 lines) + border
  }

  private doRender(): void {
    if (!this.term) return;

    this.renderCount++;

    // Full clear periodically to prevent terminal-kit memory buildup
    // First render (renderCount=1) always does full clear
    if (this.renderCount === 1 || this.renderCount % this.fullClearEvery === 0) {
      this.term.clear();
    } else {
      // Just move to top-left - faster than clear
      this.term.moveTo(1, 1);
    }

    const width = this.term.width;

    // === Header ===
    this.term.moveTo(1, 1);
    this.term.bold.cyan("fast-ngrok");

    // Status indicator
    let statusText: string;
    if (this.connected) {
      statusText = " [Connected] ";
    } else if (this.reconnecting) {
      statusText = ` [Reconnecting #${this.reconnecting.attempt}] `;
    } else {
      statusText = " [Disconnected] ";
    }
    this.term.moveTo(width - statusText.length, 1);
    if (this.connected) {
      this.term.bgGreen.black(statusText);
    } else if (this.reconnecting) {
      this.term.bgYellow.black(statusText);
    } else {
      this.term.bgRed.white(statusText);
    }

    // URL info
    this.term.moveTo(1, 2);
    if (this.publicUrl) {
      this.term.white("Forwarding: ");
      this.term.green(this.publicUrl);
      this.term.eraseLine();
      this.term.moveTo(1, 3);
      this.term.white("         -> ");
      this.term.yellow(`http://localhost:${this.localPort}`);
      this.term.eraseLine();
    } else if (this.errorMessage) {
      this.term.bgRed.white(` ERROR: ${this.errorMessage} `);
      this.term.eraseLine();
    } else {
      this.term.gray("Connecting...");
      this.term.eraseLine();
    }

    // Error message (also show if connected but error occurred)
    if (this.errorMessage && this.publicUrl) {
      this.term.moveTo(1, 3);
      this.term.bgRed.white(` ERROR: ${this.errorMessage} `);
      this.term.eraseLine();
    }

    // Separator
    this.term.moveTo(1, 4);
    this.term.gray("─".repeat(width));

    // === Request list header ===
    this.term.moveTo(1, 5);
    this.term.bold.white(
      this.formatRow("METHOD", "STATUS", "TIME", "PATH")
    );

    // === Request list ===
    const listHeight = this.getRequestListHeight();
    const visibleRequests = this.requests.slice(
      this.scrollOffset,
      this.scrollOffset + listHeight
    );

    for (let i = 0; i < listHeight; i++) {
      const y = 6 + i;
      this.term.moveTo(1, y);

      const req = visibleRequests[i];
      if (!req) {
        this.term.eraseLine();
        continue;
      }

      const method = req.method.padEnd(7);
      const isLongLived = req.connectionType === 'ws' || req.connectionType === 'sse';
      const prefix = req.connectionType === 'ws' ? 'WS' : 'SSE';

      // STATUS column (6 chars wide)
      let status: string;
      if (isLongLived) {
        if (req.status) {
          // Completed WS/SSE: "WS END" or "WS ERR"
          status = req.error ? `${prefix} ERR` : `${prefix} END`;
        } else {
          // Active WS/SSE - show activity arrow: "WS  →"
          const arrow = this.getActivityArrow(req);
          status = `${prefix}  ${arrow}`;
        }
        status = status.padEnd(6);
      } else if (req.error) {
        // Error - show ERR instead of status code
        status = "ERR   ";
      } else {
        status = req.status ? String(req.status).padEnd(6) : "...   ";
      }

      // TIME column - show progress for streaming, no time for WS/SSE
      let time: string;
      let timeIsLocal = false;
      if (req.isLocal) {
        // Local shortcut - bypassed tunnel
        time = "LOCAL   ";
        timeIsLocal = true;
      } else if (isLongLived) {
        time = "        ";
      } else if (req.bytesTransferred !== undefined && req.status === undefined) {
        // Streaming in progress - show transferred bytes
        time = this.formatBytes(req.bytesTransferred, req.totalBytes).padEnd(8);
      } else if (req.duration !== undefined) {
        time = `${req.duration}ms`.padEnd(8);
      } else {
        time = "...     ";
      }

      const maxPathLen = width - 25;
      const path = req.path.length > maxPathLen
        ? req.path.substring(0, maxPathLen - 3) + "..."
        : req.path;

      // Method color
      this.colorMethod(method);
      this.term(" ");

      // Status color
      this.colorStatus(status, req.status, isLongLived, req.error);
      this.term(" ");

      // Time
      if (timeIsLocal) {
        this.term.magenta(time);
      } else {
        this.term.yellow(time);
      }
      this.term(" ");

      // Path + clear rest of line
      this.term.white(path);
      this.term.eraseLine(); // Clear any leftover characters from previous longer path
    }

    // === Footer ===
    const footerY = this.term.height - 1;

    // Separator
    this.term.moveTo(1, footerY - 1);
    this.term.gray("─".repeat(width));

    // Stats (pre-calculated, O(1))
    this.term.moveTo(1, footerY);
    const { total, success, clientErr, serverErr } = this.stats;
    const avgTime = this.stats.completedCount > 0
      ? Math.round(this.stats.totalDuration / this.stats.completedCount)
      : 0;

    this.term.white(`Requests: ${total}`);
    this.term.gray(" | ");
    this.term.green(`2xx: ${success}`);
    this.term.gray(" | ");
    this.term.yellow(`4xx: ${clientErr}`);
    this.term.gray(" | ");
    this.term.red(`5xx: ${serverErr}`);
    this.term.gray(" | ");
    this.term.cyan(`Avg: ${avgTime}ms`);

    // Help
    const helpText = "q: quit | ↑↓: scroll";
    this.term.moveTo(width - helpText.length, footerY);
    this.term.gray(helpText);
  }

  private formatRow(
    method: string,
    status: string,
    time: string,
    path: string
  ): string {
    return `${method.padEnd(7)} ${status.padEnd(6)} ${time.padEnd(8)} ${path}`;
  }

  private colorMethod(method: string): void {
    if (!this.term) return;
    const m = method.trim();
    switch (m) {
      case "GET":
        this.term.cyan(method);
        break;
      case "POST":
        this.term.green(method);
        break;
      case "PUT":
      case "PATCH":
        this.term.yellow(method);
        break;
      case "DELETE":
        this.term.red(method);
        break;
      default:
        this.term.white(method);
    }
  }

  private colorStatus(statusStr: string, status?: number, isLongLived?: boolean, error?: boolean): void {
    if (!this.term) return;

    // WS/SSE connections
    if (isLongLived) {
      if (status) {
        // Completed
        if (error) {
          this.term.red(statusStr);
        } else {
          this.term.green(statusStr);
        }
      } else {
        // Active - magenta
        this.term.magenta(statusStr);
      }
      return;
    }

    // Error - always red
    if (error) {
      this.term.red(statusStr);
      return;
    }

    // Regular HTTP
    if (!status) {
      this.term.gray(statusStr);
      return;
    }

    if (status < 300) {
      this.term.green(statusStr);
    } else if (status < 400) {
      this.term.cyan(statusStr);
    } else if (status < 500) {
      this.term.yellow(statusStr);
    } else {
      this.term.red(statusStr);
    }
  }

  private getActivityArrow(req: RequestLog): string {
    const now = Date.now();
    const ACTIVITY_WINDOW = 1000; // 1 second

    const inActive = req.lastIncoming && (now - req.lastIncoming) < ACTIVITY_WINDOW;
    const outActive = req.lastOutgoing && (now - req.lastOutgoing) < ACTIVITY_WINDOW;

    if (inActive && outActive) return '↔';
    if (inActive) return '→';
    if (outActive) return '←';
    return '·';
  }

  private formatBytes(bytes: number, total?: number): string {
    const units = ["B", "K", "M", "G"];
    let value = bytes;
    let unitIdx = 0;
    while (value >= 1024 && unitIdx < units.length - 1) {
      value /= 1024;
      unitIdx++;
    }

    const formatted = value < 10 ? value.toFixed(1) : Math.round(value);

    if (total !== undefined) {
      // Show percentage
      const pct = Math.round((bytes / total) * 100);
      return `${pct}%`;
    }
    return `${formatted}${units[unitIdx]}`;
  }
}
