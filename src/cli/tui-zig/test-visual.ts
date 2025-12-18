/**
 * Visual test - starts the actual Zig TUI
 * Press q or Ctrl+C to exit
 */

import { ZigTUI } from "./ffi.ts";

console.log("Starting Zig TUI...");

const tui = new ZigTUI(3000);

// Set initial connected state
tui.setConnected("brave-fox-a1b2", "https://brave-fox-a1b2.tunnel.example.com");

// Add some initial requests
const methods = ["GET", "POST", "PUT", "DELETE"];
const paths = ["/api/users", "/api/login", "/api/products?page=1", "/health", "/api/settings"];
const statuses = [200, 201, 404, 500, 200];

for (let i = 0; i < 5; i++) {
  const id = `req-${i}`;
  tui.addRequest({
    id,
    method: methods[i % methods.length]!,
    path: paths[i % paths.length]!,
    startTime: Date.now(),
    connectionType: "http",
  });
  tui.updateRequest(id, statuses[i]!, 20 + i * 30);
}

// Start TUI (this starts the Zig rendering thread)
tui.start();

// Simulate updates
let counter = 5;
const interval = setInterval(() => {
  const id = `req-${counter}`;
  const method = methods[counter % methods.length] ?? "GET";
  const path = `/api/data/${counter}`;

  tui.addRequest({
    id,
    method,
    path,
    startTime: Date.now(),
    connectionType: counter % 10 === 0 ? "sse" : "http",
  });

  // Complete the request after a short delay
  setTimeout(() => {
    const status = counter % 5 === 0 ? 500 : counter % 3 === 0 ? 404 : 200;
    tui.updateRequest(id, status, 50 + Math.floor(Math.random() * 200));
  }, 100 + Math.random() * 500);

  counter++;
}, 2000);

// Handle exit
process.on("SIGINT", () => {
  clearInterval(interval);
  tui.destroy();
  process.exit(0);
});
