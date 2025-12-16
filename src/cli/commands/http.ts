import { getConfig } from "../config.ts";
import { TunnelClient } from "../tunnel-client.ts";
import { TUI } from "../tui/index.ts";

export async function httpCommand(args: string[]): Promise<void> {
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

    onConnect: (subdomain, publicUrl) => {
      tui.setConnected(subdomain, publicUrl);
    },

    onDisconnect: () => {
      tui.setDisconnected();
    },

    onError: (message) => {
      tui.setError(message);
    },
  });

  // Handle Ctrl+C
  process.on("SIGINT", () => {
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
