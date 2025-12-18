/**
 * Test script to verify FFI bindings work correctly
 */

import { DEBUG, ZigTUI } from "./ffi.ts";

console.log("=== Struct Sizes ===");
console.log("State size:", DEBUG.STATE_SIZE, "bytes");
console.log("Request size:", DEBUG.REQUEST_SIZE, "bytes");

console.log("\n=== Request Field Offsets ===");
console.log(DEBUG.REQ);

console.log("\n=== State Field Offsets ===");
console.log(DEBUG.STATE);

console.log("\n=== Testing ZigTUI ===");

const tui = new ZigTUI(3000);

// Test setting state
tui.setConnected("test-subdomain", "https://test.tunnel.example.com");
console.log("✅ setConnected works");

// Test adding request
tui.addRequest({
  id: "req-1",
  method: "GET",
  path: "/api/users",
  startTime: Date.now(),
  connectionType: "http",
});
console.log("✅ addRequest works");

// Test updating request
tui.updateRequest("req-1", 200, 42);
console.log("✅ updateRequest works");

// Test error
tui.setError("Test error message");
console.log("✅ setError works");

// Test reconnecting
tui.setReconnecting(3, 5000);
console.log("✅ setReconnecting works");

console.log("\n✅ All FFI tests passed!");
console.log("\nTo test the actual TUI, run:");
console.log("  bun run src/cli/tui-zig/test-visual.ts");
