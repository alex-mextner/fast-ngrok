import terminalKit from "terminal-kit";
import type { RequestInfo } from "../../shared/types.ts";

const term = terminalKit.terminal;

interface RequestLog extends RequestInfo {
  status?: number;
  duration?: number;
  error?: boolean;
}

export class TUI {
  private requests: RequestLog[] = [];
  private subdomain: string | null = null;
  private publicUrl: string | null = null;
  private connected = false;
  private errorMessage: string | null = null;
  private maxRequests = 100;
  private scrollOffset = 0;
  private renderInterval: Timer | null = null;

  constructor(private localPort: number) {}

  start(): void {
    term.clear();
    term.hideCursor();

    // Handle terminal resize
    term.on("resize", () => {
      this.render();
    });

    // Handle keyboard input
    term.grabInput({ mouse: false });
    term.on("key", (key: string) => {
      if (key === "CTRL_C" || key === "q") {
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
    term.grabInput(false);
    term.showCursor();
    term.clear();
  }

  setConnected(subdomain: string, publicUrl: string): void {
    this.subdomain = subdomain;
    this.publicUrl = publicUrl;
    this.connected = true;
    this.errorMessage = null;
    this.render();
  }

  setDisconnected(): void {
    this.connected = false;
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

  updateRequest(id: string, status: number, duration: number, error?: boolean): void {
    const req = this.requests.find((r) => r.id === id);
    if (req) {
      req.status = status;
      req.duration = duration;
      req.error = error;
      this.render();
    }
  }

  private getRequestListHeight(): number {
    return Math.max(1, term.height - 7); // Header (4 lines) + Footer (2 lines) + border
  }

  private render(): void {
    term.clear();

    const width = term.width;

    // === Header ===
    term.moveTo(1, 1);
    term.bold.cyan("fast-ngrok");

    // Status indicator
    const statusText = this.connected ? " [Connected] " : " [Disconnected] ";
    term.moveTo(width - statusText.length, 1);
    if (this.connected) {
      term.bgGreen.black(statusText);
    } else {
      term.bgRed.white(statusText);
    }

    // URL info
    term.moveTo(1, 2);
    if (this.publicUrl) {
      term.white("Forwarding: ");
      term.green(this.publicUrl);
      term.moveTo(1, 3);
      term.white("         -> ");
      term.yellow(`http://localhost:${this.localPort}`);
    } else {
      term.gray("Connecting...");
    }

    // Error message
    if (this.errorMessage) {
      term.moveTo(1, 3);
      term.red(`Error: ${this.errorMessage}`);
    }

    // Separator
    term.moveTo(1, 4);
    term.gray("─".repeat(width));

    // === Request list header ===
    term.moveTo(1, 5);
    term.bold.white(
      this.formatRow("METHOD", "STATUS", "TIME", "PATH", width)
    );

    // === Request list ===
    const listHeight = this.getRequestListHeight();
    const visibleRequests = this.requests.slice(
      this.scrollOffset,
      this.scrollOffset + listHeight
    );

    for (let i = 0; i < listHeight; i++) {
      const y = 6 + i;
      term.moveTo(1, y);

      const req = visibleRequests[i];
      if (!req) {
        term.eraseLine();
        continue;
      }

      const method = req.method.padEnd(7);
      const status = req.status ? String(req.status).padEnd(6) : "...   ";
      const time = req.duration !== undefined ? `${req.duration}ms`.padEnd(8) : "...     ";
      const maxPathLen = width - 25;
      const path = req.path.length > maxPathLen
        ? req.path.substring(0, maxPathLen - 3) + "..."
        : req.path;

      // Method color
      this.colorMethod(method);
      term(" ");

      // Status color
      this.colorStatus(status, req.status);
      term(" ");

      // Time
      term.yellow(time);
      term(" ");

      // Path
      term.white(path);
    }

    // === Footer ===
    const footerY = term.height - 1;

    // Separator
    term.moveTo(1, footerY - 1);
    term.gray("─".repeat(width));

    // Stats
    term.moveTo(1, footerY);
    const total = this.requests.length;
    const success = this.requests.filter((r) => r.status && r.status < 400).length;
    const clientErr = this.requests.filter((r) => r.status && r.status >= 400 && r.status < 500).length;
    const serverErr = this.requests.filter((r) => r.status && r.status >= 500).length;
    const avgTime = this.calculateAvgTime();

    term.white(`Requests: ${total}`);
    term.gray(" | ");
    term.green(`2xx: ${success}`);
    term.gray(" | ");
    term.yellow(`4xx: ${clientErr}`);
    term.gray(" | ");
    term.red(`5xx: ${serverErr}`);
    term.gray(" | ");
    term.cyan(`Avg: ${avgTime}ms`);

    // Help
    const helpText = "q: quit | ↑↓: scroll";
    term.moveTo(width - helpText.length, footerY);
    term.gray(helpText);
  }

  private formatRow(
    method: string,
    status: string,
    time: string,
    path: string,
    width: number
  ): string {
    return `${method.padEnd(7)} ${status.padEnd(6)} ${time.padEnd(8)} ${path}`;
  }

  private colorMethod(method: string): void {
    const m = method.trim();
    switch (m) {
      case "GET":
        term.cyan(method);
        break;
      case "POST":
        term.green(method);
        break;
      case "PUT":
      case "PATCH":
        term.yellow(method);
        break;
      case "DELETE":
        term.red(method);
        break;
      default:
        term.white(method);
    }
  }

  private colorStatus(statusStr: string, status?: number): void {
    if (!status) {
      term.gray(statusStr);
      return;
    }

    if (status < 300) {
      term.green(statusStr);
    } else if (status < 400) {
      term.cyan(statusStr);
    } else if (status < 500) {
      term.yellow(statusStr);
    } else {
      term.red(statusStr);
    }
  }

  private calculateAvgTime(): number {
    const completed = this.requests.filter((r) => r.duration !== undefined);
    if (completed.length === 0) return 0;

    const total = completed.reduce((sum, r) => sum + (r.duration || 0), 0);
    return Math.round(total / completed.length);
  }
}
