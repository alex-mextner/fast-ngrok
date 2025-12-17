import { getConfig } from "../config.ts";
import { TunnelClient } from "../tunnel-client.ts";
import { TUI } from "../tui/index.ts";
import {
  LocalShortcut,
  shouldEnableLocalShortcut,
  preSetupLocalShortcut,
} from "../local-shortcut/index.ts";

export interface HttpCommandOptions {
  noLocalShortcut: boolean;
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

  const config = await getConfig();

  if (!config) {
    console.error("Not configured. Run: fast-ngrok auth");
    process.exit(1);
  }

  const enableLocalShortcut = shouldEnableLocalShortcut(options.noLocalShortcut);
  let localShortcut: LocalShortcut | null = null;

  // Pre-setup local shortcut BEFORE TUI starts (may require sudo password)
  let certPaths: Awaited<ReturnType<typeof preSetupLocalShortcut>> = null;
  if (enableLocalShortcut) {
    certPaths = await preSetupLocalShortcut(config.serverUrl);
  }

  const tui = new TUI(port);

  const client = new TunnelClient({
    serverUrl: config.serverUrl,
    apiKey: config.apiKey,
    localPort: port,

    onRequest: (req) => {
      tui.addRequest(req);
    },

    onResponse: (id, status, duration, error) => {
      tui.updateRequest(id, status, duration, error);
    },

    onConnect: async (subdomain, publicUrl) => {
      tui.setConnected(subdomain, publicUrl);

      // Activate local shortcut (certs already generated)
      if (certPaths) {
        localShortcut = new LocalShortcut({
          localPort: port,
          certPaths,
        });
        const hostname = new URL(publicUrl).hostname;
        await localShortcut.activate(hostname);
      }
    },

    onDisconnect: () => {
      tui.setDisconnected();
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
