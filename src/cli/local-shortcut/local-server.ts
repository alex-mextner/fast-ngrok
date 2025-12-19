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

// WebSocket passthrough data
interface WsData {
  localWs: WebSocket | null;
  localPort: number;
  path: string;
}

export class LocalServer {
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(private options: LocalServerOptions) {}

  /**
   * Start local HTTPS server (pf forwarding should be set up in preSetup)
   */
  async start(): Promise<void> {
    const localPort = this.options.localPort;

    // Start HTTPS server on high port
    this.server = Bun.serve<WsData>({
      port: LOCAL_HTTPS_PORT,
      tls: {
        cert: Bun.file(this.options.certPaths.cert),
        key: Bun.file(this.options.certPaths.key),
      },
      fetch: async (req, server) => {
        // Check for WebSocket upgrade
        const upgrade = req.headers.get("upgrade")?.toLowerCase();
        const connection = req.headers.get("connection")?.toLowerCase();

        if (upgrade === "websocket" && connection?.includes("upgrade")) {
          const url = new URL(req.url);
          const upgraded = server.upgrade(req, {
            data: { localWs: null, localPort, path: url.pathname + url.search },
          });
          if (upgraded) return undefined;
          return new Response("WebSocket upgrade failed", { status: 500 });
        }

        return this.handleRequest(req);
      },
      websocket: {
        open(ws) {
          // Connect to local WebSocket
          const { localPort, path } = ws.data;
          const localWsUrl = `ws://127.0.0.1:${localPort}${path}`;

          try {
            const localWs = new WebSocket(localWsUrl);
            ws.data.localWs = localWs;

            localWs.addEventListener("open", () => {
              // Connection established
            });

            localWs.addEventListener("message", (event) => {
              if (ws.readyState !== 1) return;
              if (typeof event.data === "string") {
                ws.send(event.data);
              } else if (event.data instanceof ArrayBuffer) {
                ws.send(new Uint8Array(event.data));
              } else if (event.data instanceof Blob) {
                event.data.arrayBuffer().then((buffer) => {
                  if (ws.readyState === 1) ws.send(new Uint8Array(buffer));
                });
              }
            });

            localWs.addEventListener("close", (event) => {
              ws.close(event.code, event.reason);
            });

            localWs.addEventListener("error", () => {
              ws.close(1011, "Local WebSocket error");
            });
          } catch {
            ws.close(1011, "Failed to connect to local WebSocket");
          }
        },
        message(ws, message) {
          const { localWs } = ws.data;
          if (localWs && localWs.readyState === WebSocket.OPEN) {
            if (typeof message === "string") {
              localWs.send(message);
            } else {
              localWs.send(message);
            }
          }
        },
        close(ws, code, reason) {
          const { localWs } = ws.data;
          if (localWs) {
            try {
              localWs.close(code, reason);
            } catch {
              // Already closed
            }
          }
        },
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

  const ruleFile = "/tmp/fast-ngrok-pf.conf";
  const rule = `rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 443 -> 127.0.0.1 port ${LOCAL_HTTPS_PORT}`;

  try {
    // Write rule to temp file
    await Bun.write(ruleFile, rule + "\n");

    // Load rules from file into anchor
    const result = await Bun.$`sudo pfctl -a ${PF_ANCHOR} -f ${ruleFile} 2>&1`.quiet().nothrow();

    if (result.exitCode !== 0) {
      const output = result.stdout.toString() + result.stderr.toString();
      // Ignore ALTQ warnings, they're harmless
      if (!output.includes("syntax error") && !output.includes("error")) {
        // Warnings are OK
      } else {
        throw new Error(output);
      }
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
