/**
 * Local Shortcut - bypass tunnel for local requests
 *
 * When enabled:
 * 1. Adds entry to /etc/hosts pointing tunnel domain to 127.0.0.1
 * 2. Runs local HTTPS server with mkcert certificate
 * 3. Local requests go directly to app, no round-trip through VPS
 *
 * Requires: macOS, Homebrew (for mkcert auto-install)
 */

import { platform } from "os";
import { addHostsEntry } from "./hosts.ts";
import { ensureMkcertReady, type CertPaths } from "./mkcert.ts";
import { LocalServer } from "./local-server.ts";

export interface LocalShortcutOptions {
  localPort: number;
  certPaths: CertPaths; // Pre-generated certs
  onLocalRequest?: (method: string, path: string) => void;
}

export class LocalShortcut {
  private localServer: LocalServer | null = null;
  private hostname: string | null = null;
  private setupComplete = false;

  constructor(private options: LocalShortcutOptions) {}

  /**
   * Check if local shortcut is supported on this platform
   */
  static isSupported(): boolean {
    return platform() === "darwin";
  }

  /**
   * Activate local shortcut for a specific hostname
   * Called after server connection when we know the subdomain
   */
  async activate(hostname: string): Promise<void> {
    this.hostname = hostname;

    if (!this.hostname || !this.hostname.includes(".")) {
      console.warn("⚠️  Invalid hostname, skipping local shortcut");
      return;
    }

    try {
      // 1. Add hosts entry (no sudo if already exists)
      const wasAdded = await addHostsEntry(this.hostname);
      if (wasAdded) {
        console.log(`\n📝 Added ${this.hostname} to /etc/hosts`);
      } else {
        console.log(`\n✅ ${this.hostname} already in /etc/hosts`);
      }

      // 2. Start local HTTPS server
      console.log("🔒 Starting local HTTPS server...");
      this.localServer = new LocalServer({
        localPort: this.options.localPort,
        certPaths: this.options.certPaths,
        onRequest: this.options.onLocalRequest,
      });
      await this.localServer.start();
      console.log("✅ Local HTTPS server started");

      this.setupComplete = true;
      console.log(
        `\n✨ Local shortcut active - requests to ${this.hostname} go directly to localhost:${this.options.localPort}\n`
      );
    } catch (error) {
      console.error(
        `\n⚠️  Local shortcut activation failed: ${error instanceof Error ? error.message : error}`
      );
      console.error(
        "   Continuing without local shortcut (requests will go through tunnel)\n"
      );
      await this.cleanup();
    }
  }

  /**
   * Cleanup: remove hosts entry and stop server
   */
  async stop(): Promise<void> {
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    // Stop local server (hosts entry stays for next run)
    if (this.localServer) {
      await this.localServer.stop();
      this.localServer = null;
    }
  }

  get isActive(): boolean {
    return this.setupComplete;
  }
}

/**
 * Check if local shortcut feature should be enabled
 */
export function shouldEnableLocalShortcut(noLocalShortcut: boolean): boolean {
  if (noLocalShortcut) {
    return false;
  }

  if (!LocalShortcut.isSupported()) {
    return false;
  }

  return true;
}

/**
 * Extract base domain from server URL
 * e.g., "https://tunnel.example.com" -> "tunnel.example.com"
 */
export function extractBaseDomainFromServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  return url.hostname;
}

/**
 * Pre-setup: install mkcert, CA, and generate certs
 * Should be called BEFORE connecting to server
 * Returns certPaths or null if setup failed
 */
export async function preSetupLocalShortcut(
  serverUrl: string
): Promise<CertPaths | null> {
  if (!LocalShortcut.isSupported()) {
    return null;
  }

  console.log("\n🚀 Setting up local shortcut...");

  try {
    // 0. Extract base domain from server URL (from auth config)
    const baseDomain = extractBaseDomainFromServerUrl(serverUrl);
    console.log(`📋 Base domain: ${baseDomain}`);

    // 1. Ensure mkcert is ready and get cert paths
    const certPaths = await ensureMkcertReady(baseDomain);

    console.log("✅ Certificates ready\n");
    return certPaths;
  } catch (error) {
    console.error(
      `\n⚠️  Local shortcut pre-setup failed: ${error instanceof Error ? error.message : error}`
    );
    console.error("   Will connect without local shortcut\n");
    return null;
  }
}
