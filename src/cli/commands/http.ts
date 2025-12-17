import { connect, type Socket } from "node:net";
import { getConfig } from "../config.ts";
import { TunnelClient } from "../tunnel-client.ts";
import { TUI } from "../tui/index.ts";
import {
  LocalShortcut,
  shouldEnableLocalShortcut,
  preSetupLocalShortcut,
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
    subdomain: options.subdomain,

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
