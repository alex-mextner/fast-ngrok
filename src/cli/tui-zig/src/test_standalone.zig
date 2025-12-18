const std = @import("std");
const tui = @import("main.zig");

pub fn main() !void {
    // Create state
    var state: tui.State = undefined;
    @memset(std.mem.asBytes(&state), 0);

    // Initialize with some test data
    state.connected = true;
    state.local_port = 3000;

    const url = "https://brave-fox.tunnel.example.com";
    @memcpy(state.public_url[0..url.len], url);
    state.public_url_len = url.len;

    // Add some test requests
    addTestRequest(&state, "GET", "/api/users", 200, 42);
    addTestRequest(&state, "POST", "/api/login", 200, 156);
    addTestRequest(&state, "GET", "/api/products?page=1&limit=20", 200, 89);
    addTestRequest(&state, "DELETE", "/api/users/123", 404, 12);
    addTestRequest(&state, "PUT", "/api/settings", 500, 234);
    addTestRequest(&state, "GET", "/health", 200, 5);

    state.stats_total = 6;
    state.stats_2xx = 4;
    state.stats_4xx = 1;
    state.stats_5xx = 1;
    state.stats_avg_ms = 90;

    state.version.store(1, .release);

    // Start TUI
    if (!tui.tui_init(&state)) {
        std.debug.print("Failed to start TUI\n", .{});
        return;
    }

    // Simulate updates
    var timer: u32 = 0;
    while (tui.tui_is_running()) {
        std.Thread.sleep(1 * std.time.ns_per_s);
        timer += 1;

        // Add a new request every 2 seconds
        if (timer % 2 == 0) {
            const methods = [_][]const u8{ "GET", "POST", "PUT", "DELETE" };
            const paths = [_][]const u8{ "/api/data", "/webhook", "/events", "/status" };
            const statuses = [_]u16{ 200, 201, 400, 500 };

            const method = methods[timer % methods.len];
            const path = paths[timer % paths.len];
            const status = statuses[timer % statuses.len];

            addTestRequest(&state, method, path, status, @as(u32, @intCast(timer * 10)));
            state.stats_total += 1;
            if (status < 300) state.stats_2xx += 1 else if (status < 500) state.stats_4xx += 1 else state.stats_5xx += 1;

            _ = state.version.fetchAdd(1, .release);
        }
    }

    tui.tui_shutdown();
}

fn addTestRequest(state: *tui.State, method: []const u8, path: []const u8, status: u16, duration: u32) void {
    const idx = state.request_head;
    var req = &state.requests[idx];

    @memset(std.mem.asBytes(req), 0);
    @memcpy(req.method[0..method.len], method);
    req.method_len = @intCast(method.len);
    @memcpy(req.path[0..path.len], path);
    req.path_len = @intCast(path.len);
    req.status = status;
    req.duration_ms = duration;
    req.id = state.request_count;

    state.request_head = (state.request_head + 1) % tui.MAX_REQUESTS;
    if (state.request_count < tui.MAX_REQUESTS) {
        state.request_count += 1;
    }
}
