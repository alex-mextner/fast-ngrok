// Simple WebSocket test without TUI
import { getConfig } from "./src/cli/config.ts";

const config = await getConfig();
if (!config) {
  console.error("Not configured");
  process.exit(1);
}

const wsUrl = config.serverUrl.replace("https://", "wss://").replace("http://", "ws://");
const connectUrl = `${wsUrl}/__tunnel__/connect`;

console.log(`Connecting to: ${connectUrl}`);

const ws = new WebSocket(connectUrl, {
  headers: {
    "x-api-key": config.apiKey,
  },
} as unknown as string | string[]);

ws.addEventListener("open", () => {
  console.log("[ws] Connected!");
});

ws.addEventListener("message", (event) => {
  console.log("[ws] Message:", event.data.toString());
});

ws.addEventListener("close", (event) => {
  console.log(`[ws] Closed: code=${event.code}, reason="${event.reason}", wasClean=${event.wasClean}`);
});

ws.addEventListener("error", (event) => {
  console.error("[ws] Error:", event);
});

// Keep alive
setInterval(() => {}, 1000);
