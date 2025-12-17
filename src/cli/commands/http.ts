import { connect, type Socket } from "node:net";
import { getConfig, saveConfig } from "../config.ts";
import { TunnelClient } from "../tunnel-client.ts";
import { TUI } from "../tui/index.ts";
import {
  LocalShortcut,
  shouldEnableLocalShortcut,
  preSetupLocalShortcut,
  removeAllHostsEntries,
  type PreSetupResult,
} from "../local-shortcut/index.ts";

async function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket: Socket = connect(port, "127.0.0.1");

    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });

    // Timeout after 1 second
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export interface HttpCommandOptions {
  noLocalShortcut: boolean;
  subdomain?: string;
}

export async function httpCommand(
  args: string[],
  options: HttpCommandOptions
): Promise<void> {
  const port = parseInt(args[0] || "", 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    console.error("Usage: fast-ngrok http <port>");
    console.error("Example: fast-ngrok http 3000");
    process.exit(1);
  }

  // Check if something is listening on the port
  const portListening = await isPortListening(port);
  if (!portListening) {
    console.error(`\nNothing is running on port ${port}.\n`);
    console.error(`For fast-ngrok to work, you need to start your service on port ${port}`);
    console.error(`so that requests from the internet can reach it.\n`);
    console.error(`Start your service first, then run fast-ngrok again.\n`);
    console.error(`If your service is running on a different port, use that port instead:`);
    console.error(`  fast-ngrok http <your-actual-port>\n`);
    process.exit(1);
  }

  const config = await getConfig();

  if (!config) {
    console.error("Not configured. Run: fast-ngrok auth");
    process.exit(1);
  }

  // Check server availability before starting TUI
  try {
    const healthUrl = `${config.serverUrl}/__tunnel__/health`;
    const response = await fetch(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.error(`\nServer returned ${response.status}. Is the tunnel server running?`);
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nCannot connect to tunnel server at ${config.serverUrl}`);
    console.error(`Error: ${message}\n`);
    console.error(`Make sure the tunnel server is running and accessible.`);
    process.exit(1);
  }

  // Use explicit subdomain, or cached subdomain for this port
  const subdomain = options.subdomain ?? config.portSubdomains?.[port];

  const enableLocalShortcut = shouldEnableLocalShortcut(options.noLocalShortcut);
  let localShortcut: LocalShortcut | null = null;

  // Pre-setup local shortcut BEFORE TUI starts (may require sudo password)
  let preSetupResult: PreSetupResult | null = null;
  if (enableLocalShortcut) {
    // Pass cached subdomain so hosts entry can be added before TUI
    preSetupResult = await preSetupLocalShortcut(config.serverUrl, subdomain);
  } else {
    // Remove hosts entries if local shortcut disabled (otherwise DNS points to localhost with nothing listening)
    try {
      const removed = await removeAllHostsEntries();
      if (removed) {
        console.log("🗑️  Removed local shortcut hosts entries\n");
      }
    } catch {
      // Ignore - might not have sudo or no entries to remove
    }
  }

  const tui = new TUI(port);

  const client = new TunnelClient({
    serverUrl: config.serverUrl,
    apiKey: config.apiKey,
    localPort: port,
    subdomain,

    onRequest: (req) => {
      tui.addRequest(req);
    },

    onResponse: (id, status, duration, error) => {
      tui.updateRequest(id, status, duration, error);
    },

    onActivity: (id, direction) => {
      tui.updateActivity(id, direction);
    },

    onConnect: async (connectedSubdomain, publicUrl) => {
      tui.setConnected(connectedSubdomain, publicUrl);

      // Cache subdomain for this port
      const updatedConfig = {
        ...config,
        portSubdomains: {
          ...config.portSubdomains,
          [port]: connectedSubdomain,
        },
      };
      await saveConfig(updatedConfig);

      // Activate local shortcut (certs already generated)
      if (preSetupResult) {
        localShortcut = new LocalShortcut({
          localPort: port,
          certPaths: preSetupResult.certPaths,
          hostsReady: preSetupResult.hostsReady,
        });
        const hostname = new URL(publicUrl).hostname;
        await localShortcut.activate(hostname);
      }
    },

    onDisconnect: () => {
      tui.setDisconnected();
    },

    onReconnecting: (attempt, delayMs) => {
      tui.setReconnecting(attempt, delayMs);
    },

    onError: (message) => {
      tui.setError(message);
    },
  });

  // Handle Ctrl+C - cleanup local shortcut
  process.on("SIGINT", async () => {
    if (localShortcut) {
      await localShortcut.stop();
    }
    tui.destroy();
    client.disconnect();
    process.exit(0);
  });

  tui.start();

  try {
    await client.connect();
  } catch (error) {
    tui.destroy();
    console.error(
      `Failed to connect: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    process.exit(1);
  }
}
