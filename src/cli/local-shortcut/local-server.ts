/**
 * Local HTTPS server that proxies to localhost:PORT
 * Allows local requests to bypass the tunnel round-trip
 */

import type { CertPaths } from "./mkcert.ts";

export const LOCAL_HTTPS_PORT = 8443;
const PF_ANCHOR = "fast-ngrok";

export interface LocalServerOptions {
  localPort: number;
  certPaths: CertPaths;
  onRequest?: (method: string, path: string) => void;
}

export class LocalServer {
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(private options: LocalServerOptions) {}

  /**
   * Start local HTTPS server (pf forwarding should be set up in preSetup)
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
  }

  /**
   * Stop server (pf rules are kept for next run)
   */
  async stop(): Promise<void> {
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

}

/**
 * Check if pf redirect rule is already active
 */
async function isPfRedirectActive(): Promise<boolean> {
  try {
    const result = await Bun.$`sudo pfctl -a ${PF_ANCHOR} -s rules 2>/dev/null`.quiet();
    const output = result.stdout.toString();
    return output.includes("rdr pass") && output.includes("port 443");
  } catch {
    return false;
  }
}

/**
 * Setup pf port forwarding on macOS (443 -> 8443)
 * Should be called in preSetup before TUI starts
 * Returns true if redirect is working
 */
export async function ensurePfRedirect(): Promise<boolean> {
  // Check if already active
  if (await isPfRedirectActive()) {
    return true;
  }

  const rule = `rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 443 -> 127.0.0.1 port ${LOCAL_HTTPS_PORT}`;

  try {
    // Add anchor rule
    const proc = Bun.spawn(["sudo", "pfctl", "-a", PF_ANCHOR, "-f", "-"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(rule);
    proc.stdin.end();

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(stderr);
    }

    // Enable pf if not already enabled
    await Bun.$`sudo pfctl -e 2>/dev/null || true`.quiet();

    return true;
  } catch (error) {
    console.warn(
      `⚠️  Could not setup port forwarding: ${error instanceof Error ? error.message : error}`
    );
    return false;
  }
}
