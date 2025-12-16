/**
 * Local HTTPS server that proxies to localhost:PORT
 * Allows local requests to bypass the tunnel round-trip
 */

import type { CertPaths } from "./mkcert.ts";

const LOCAL_HTTPS_PORT = 8443;

export interface LocalServerOptions {
  localPort: number;
  certPaths: CertPaths;
  onRequest?: (method: string, path: string) => void;
}

export class LocalServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private pfEnabled = false;

  constructor(private options: LocalServerOptions) {}

  /**
   * Start local HTTPS server with port forwarding
   */
  async start(): Promise<void> {
    // Start HTTPS server on high port
    this.server = Bun.serve({
      port: LOCAL_HTTPS_PORT,
      tls: {
        cert: Bun.file(this.options.certPaths.cert),
        key: Bun.file(this.options.certPaths.key),
      },
      fetch: async (req) => {
        return this.handleRequest(req);
      },
    });

    // Setup port forwarding 443 -> 8443
    await this.enablePortForward();
  }

  /**
   * Stop server and cleanup
   */
  async stop(): Promise<void> {
    if (this.pfEnabled) {
      await this.disablePortForward();
    }
    this.server?.stop();
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    this.options.onRequest?.(req.method, url.pathname);

    try {
      // Forward to local app
      const localUrl = `http://127.0.0.1:${this.options.localPort}${url.pathname}${url.search}`;

      const headers = new Headers(req.headers);
      // Remove host header to avoid confusion
      headers.delete("host");

      const response = await fetch(localUrl, {
        method: req.method,
        headers,
        body: req.body,
        // @ts-expect-error - Bun supports duplex
        duplex: "half",
      });

      // Clone response with CORS headers for local dev
      const responseHeaders = new Headers(response.headers);

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      return new Response(
        `Local server error: ${error instanceof Error ? error.message : "Unknown error"}`,
        { status: 502 }
      );
    }
  }

  /**
   * Enable pf port forwarding on macOS
   * Redirects 443 -> 8443 on loopback
   */
  private async enablePortForward(): Promise<void> {
    const anchor = "fast-ngrok";
    const rule = `rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 443 -> 127.0.0.1 port ${LOCAL_HTTPS_PORT}`;

    try {
      // Add anchor rule
      const proc = Bun.spawn(["sudo", "pfctl", "-a", anchor, "-f", "-"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      proc.stdin.write(rule);
      proc.stdin.end();

      await proc.exited;

      // Enable pf if not already enabled
      await Bun.$`sudo pfctl -e 2>/dev/null || true`.quiet();

      this.pfEnabled = true;
    } catch (error) {
      console.warn(
        `⚠️  Could not setup port forwarding: ${error instanceof Error ? error.message : error}`
      );
      console.warn(`   Local shortcut will use port ${LOCAL_HTTPS_PORT} instead of 443`);
    }
  }

  /**
   * Disable pf port forwarding
   */
  private async disablePortForward(): Promise<void> {
    try {
      const anchor = "fast-ngrok";
      await Bun.$`sudo pfctl -a ${anchor} -F all 2>/dev/null`.quiet();
      this.pfEnabled = false;
    } catch {
      // Ignore errors during cleanup
    }
  }

  get port(): number {
    return this.pfEnabled ? 443 : LOCAL_HTTPS_PORT;
  }
}
