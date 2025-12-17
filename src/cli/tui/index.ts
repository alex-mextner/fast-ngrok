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

export class TUI {
  private requests: RequestLog[] = [];
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

    // Periodic render for elapsed time updates
    this.renderInterval = setInterval(() => {
      this.render();
    }, 1000);
  }

  destroy(): void {
    if (this.renderInterval) {
      clearInterval(this.renderInterval);
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
    this.render();
  }

  setDisconnected(): void {
    this.connected = false;
    this.render();
  }

  setReconnecting(attempt: number, delayMs: number): void {
    this.reconnecting = { attempt, delayMs };
    this.render();
  }

  setError(message: string): void {
    this.errorMessage = message;
    this.render();
  }

  addRequest(req: RequestInfo): void {
    this.requests.unshift({
      ...req,
    });

    if (this.requests.length > this.maxRequests) {
      this.requests.pop();
    }

    // Auto-scroll to top for new requests
    this.scrollOffset = 0;
    this.render();
  }

  // Add request that went through local shortcut (bypassed tunnel)
  addLocalRequest(method: string, path: string): void {
    this.requests.unshift({
      id: crypto.randomUUID(),
      method,
      path,
      startTime: Date.now(),
      connectionType: "http",
      status: 200,
      duration: 0,
      isLocal: true,
    });

    if (this.requests.length > this.maxRequests) {
      this.requests.pop();
    }

    this.scrollOffset = 0;
    this.render();
  }

  updateRequest(id: string, status: number, duration: number, error?: boolean): void {
    const req = this.requests.find((r) => r.id === id);
    if (req) {
      req.status = status;
      req.duration = duration;
      req.error = error;
      this.render();
    }
  }

  updateActivity(id: string, direction: 'in' | 'out'): void {
    const req = this.requests.find((r) => r.id === id);
    if (req) {
      const now = Date.now();
      if (direction === 'in') req.lastIncoming = now;
      else req.lastOutgoing = now;
      this.render();
    }
  }

  updateProgress(id: string, bytesTransferred: number, totalBytes?: number): void {
    const req = this.requests.find((r) => r.id === id);
    if (req) {
      req.bytesTransferred = bytesTransferred;
      if (totalBytes !== undefined) req.totalBytes = totalBytes;
      this.render();
    }
  }

  // Update with real end-to-end duration from server
  updateTiming(id: string, duration: number): void {
    const req = this.requests.find((r) => r.id === id);
    if (req) {
      req.duration = duration;
      this.render();
    }
  }

  setRequestError(id: string, message: string, duration: number): void {
    const req = this.requests.find((r) => r.id === id);
    if (req) {
      req.error = true;
      req.errorMessage = message;
      req.duration = duration;
      this.render();
    }
  }

  private getRequestListHeight(): number {
    if (!this.term) return 10;
    return Math.max(1, this.term.height - 7); // Header (4 lines) + Footer (2 lines) + border
  }

  private render(): void {
    if (!this.term) return;

    this.term.clear();

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
      this.term.moveTo(1, 3);
      this.term.white("         -> ");
      this.term.yellow(`http://localhost:${this.localPort}`);
    } else if (this.errorMessage) {
      this.term.bgRed.white(` ERROR: ${this.errorMessage} `);
    } else {
      this.term.gray("Connecting...");
    }

    // Error message (also show if connected but error occurred)
    if (this.errorMessage && this.publicUrl) {
      this.term.moveTo(1, 3);
      this.term.bgRed.white(` ERROR: ${this.errorMessage} `);
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

      // Path
      this.term.white(path);
    }

    // === Footer ===
    const footerY = this.term.height - 1;

    // Separator
    this.term.moveTo(1, footerY - 1);
    this.term.gray("─".repeat(width));

    // Stats
    this.term.moveTo(1, footerY);
    const total = this.requests.length;
    const success = this.requests.filter((r) => r.status && r.status < 400).length;
    const clientErr = this.requests.filter((r) => r.status && r.status >= 400 && r.status < 500).length;
    const serverErr = this.requests.filter((r) => r.status && r.status >= 500).length;
    const avgTime = this.calculateAvgTime();

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

  private calculateAvgTime(): number {
    const completed = this.requests.filter((r) => r.duration !== undefined);
    if (completed.length === 0) return 0;

    const total = completed.reduce((sum, r) => sum + (r.duration || 0), 0);
    return Math.round(total / completed.length);
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
