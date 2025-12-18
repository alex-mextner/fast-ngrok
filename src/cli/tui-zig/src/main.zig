const std = @import("std");
const vaxis = @import("vaxis");

const Color = vaxis.Cell.Color;
const Style = vaxis.Cell.Style;
const Segment = vaxis.Cell.Segment;

// ANSI color indices
const C_RED: Color = .{ .index = 1 };
const C_GREEN: Color = .{ .index = 2 };
const C_YELLOW: Color = .{ .index = 3 };
const C_BLUE: Color = .{ .index = 4 };
const C_MAGENTA: Color = .{ .index = 5 };
const C_CYAN: Color = .{ .index = 6 };
const C_WHITE: Color = .{ .index = 7 };

// Connection types
const CONN_HTTP: u8 = 0;
const CONN_WS: u8 = 1;
const CONN_SSE: u8 = 2;

// Activity window for WS/SSE arrows (1 second)
const ACTIVITY_WINDOW_MS: i64 = 1000;

fn getActivityArrow(req: *const Request) []const u8 {
    const now = std.time.milliTimestamp();
    const in_active = req.last_incoming > 0 and (now - @as(i64, @intCast(req.last_incoming))) < ACTIVITY_WINDOW_MS;
    const out_active = req.last_outgoing > 0 and (now - @as(i64, @intCast(req.last_outgoing))) < ACTIVITY_WINDOW_MS;

    if (in_active and out_active) return "\xe2\x86\x94"; // ↔
    if (in_active) return "\xe2\x86\x92"; // →
    if (out_active) return "\xe2\x86\x90"; // ←
    return "\xc2\xb7"; // ·
}

// ============================================================================
// Shared State - written by Bun, read by Zig TUI thread
// ============================================================================

pub const MAX_REQUESTS = 100;
pub const MAX_URL_LEN = 256;
pub const MAX_PATH_LEN = 512;
pub const MAX_METHOD_LEN = 16;
pub const MAX_ERROR_LEN = 256;

pub const Request = extern struct {
    id: u64,
    method: [MAX_METHOD_LEN]u8,
    method_len: u8,
    path: [MAX_PATH_LEN]u8,
    path_len: u16,
    status: u16,
    duration_ms: u32,
    is_error: bool,
    is_local: bool,
    connection_type: u8,
    _padding: [5]u8,
    // Activity timestamps for WS/SSE (milliseconds since epoch)
    last_incoming: u64,
    last_outgoing: u64,
};

pub const State = extern struct {
    connected: bool,
    reconnecting: bool,
    reconnect_attempt: u8,
    _pad1: u8,

    public_url: [MAX_URL_LEN]u8,
    public_url_len: u16,
    local_port: u16,

    error_message: [MAX_ERROR_LEN]u8,
    error_len: u16,
    _pad2: u16,

    requests: [MAX_REQUESTS]Request,
    request_count: u32,
    request_head: u32,

    stats_total: u32,
    stats_2xx: u32,
    stats_4xx: u32,
    stats_5xx: u32,
    stats_avg_ms: u32,

    version: std.atomic.Value(u32),
};

// ============================================================================
// TUI Application
// ============================================================================

const App = struct {
    state: *State,
    last_version: u32,
    scroll_offset: u32,
    should_quit: bool,

    // Persistent buffers for formatted strings (vaxis stores slice refs)
    local_url_buf: [32]u8,
    // Stats buffers (separate for colors)
    stats_total_buf: [16]u8,
    stats_2xx_buf: [12]u8,
    stats_4xx_buf: [12]u8,
    stats_5xx_buf: [12]u8,
    // Per-request buffers (for visible requests only)
    status_bufs: [20][8]u8,
    time_bufs: [20][16]u8,

    pub fn init(state: *State) App {
        return .{
            .state = state,
            .last_version = 0,
            .scroll_offset = 0,
            .should_quit = false,
            .local_url_buf = .{0} ** 32,
            .stats_total_buf = .{0} ** 16,
            .stats_2xx_buf = .{0} ** 12,
            .stats_4xx_buf = .{0} ** 12,
            .stats_5xx_buf = .{0} ** 12,
            .status_bufs = .{.{0} ** 8} ** 20,
            .time_bufs = .{.{0} ** 16} ** 20,
        };
    }

    pub fn handleKey(self: *App, key: vaxis.Key) void {
        // Support both English and Russian keyboard layouts
        // q/й = quit, k/л = up, j/о = down
        if (key.matches('c', .{ .ctrl = true }) or key.matches('q', .{}) or key.matches(0x439, .{})) { // й
            self.should_quit = true;
        } else if (key.matches(vaxis.Key.up, .{}) or key.matches('k', .{}) or key.matches(0x43B, .{})) { // л
            if (self.scroll_offset > 0) self.scroll_offset -= 1;
        } else if (key.matches(vaxis.Key.down, .{}) or key.matches('j', .{}) or key.matches(0x43E, .{})) { // о
            self.scroll_offset += 1;
        }
    }

    pub fn render(self: *App, win: vaxis.Window) void {
        win.clear();

        const width = win.width;
        const height = win.height;
        var row: u16 = 0;

        // Header
        self.drawHeader(win, &row);

        // Separator
        row += 1;
        self.drawSeparator(win, row, width);
        row += 1;

        // Request list
        const list_height: u16 = if (height > 8) height - 8 else 4;
        self.drawRequestList(win, &row, list_height);

        // Footer
        if (height > 3) {
            const footer_row = height - 3;
            self.drawSeparator(win, footer_row, width);
            self.drawStats(win, footer_row + 1);
        }
    }

    fn drawHeader(self: *App, win: vaxis.Window, row: *u16) void {
        // Title
        _ = win.printSegment(.{ .text = "fast-ngrok", .style = .{ .fg = C_CYAN, .bold = true } }, .{ .row_offset = row.*, .col_offset = 0 });

        // Status
        if (self.state.connected) {
            _ = win.printSegment(.{ .text = " ONLINE ", .style = .{ .fg = C_GREEN, .bold = true } }, .{ .row_offset = row.*, .col_offset = 12 });
        } else if (self.state.reconnecting) {
            _ = win.printSegment(.{ .text = " RECONNECTING ", .style = .{ .fg = C_YELLOW } }, .{ .row_offset = row.*, .col_offset = 12 });
        } else {
            _ = win.printSegment(.{ .text = " OFFLINE ", .style = .{ .fg = C_RED } }, .{ .row_offset = row.*, .col_offset = 12 });
        }
        row.* += 1;

        // URL (with bounds check)
        const url_len = @min(self.state.public_url_len, MAX_URL_LEN);
        if (url_len > 0) {
            const url = self.state.public_url[0..url_len];
            _ = win.printSegment(.{ .text = "Forwarding: " }, .{ .row_offset = row.*, .col_offset = 0 });
            _ = win.printSegment(.{ .text = url, .style = .{ .fg = C_GREEN } }, .{ .row_offset = row.*, .col_offset = 12 });
            row.* += 1;

            // Use persistent buffer for formatted URL
            const local = std.fmt.bufPrint(&self.local_url_buf, "http://localhost:{d}", .{self.state.local_port}) catch "localhost";
            _ = win.printSegment(.{ .text = "         -> " }, .{ .row_offset = row.*, .col_offset = 0 });
            _ = win.printSegment(.{ .text = local, .style = .{ .fg = C_YELLOW } }, .{ .row_offset = row.*, .col_offset = 12 });
            row.* += 1;

            // Error on separate row (under -> localhost)
            if (self.state.error_len > 0) {
                const err_len = @min(self.state.error_len, MAX_ERROR_LEN);
                const err = self.state.error_message[0..err_len];
                _ = win.printSegment(.{ .text = "ERROR: ", .style = .{ .fg = C_WHITE, .bg = C_RED } }, .{ .row_offset = row.*, .col_offset = 0 });
                _ = win.printSegment(.{ .text = err, .style = .{ .fg = C_WHITE, .bg = C_RED } }, .{ .row_offset = row.*, .col_offset = 7 });
            }
        } else if (self.state.error_len > 0) {
            const err_len = @min(self.state.error_len, MAX_ERROR_LEN);
            const err = self.state.error_message[0..err_len];
            _ = win.printSegment(.{ .text = "ERROR: ", .style = .{ .fg = C_WHITE, .bg = C_RED } }, .{ .row_offset = row.*, .col_offset = 0 });
            _ = win.printSegment(.{ .text = err, .style = .{ .fg = C_WHITE, .bg = C_RED } }, .{ .row_offset = row.*, .col_offset = 7 });
        } else {
            _ = win.printSegment(.{ .text = "Connecting...", .style = .{ .dim = true } }, .{ .row_offset = row.*, .col_offset = 0 });
        }
        row.* += 1;
    }

    fn drawSeparator(_: *App, win: vaxis.Window, row: u16, width: u16) void {
        var col: u16 = 0;
        while (col < width) : (col += 1) {
            _ = win.printSegment(.{ .text = "─", .style = .{ .dim = true } }, .{ .row_offset = row, .col_offset = col });
        }
    }

    fn drawRequestList(self: *App, win: vaxis.Window, row: *u16, height: u16) void {
        // Header
        _ = win.printSegment(.{ .text = "METHOD", .style = .{ .dim = true } }, .{ .row_offset = row.*, .col_offset = 0 });
        _ = win.printSegment(.{ .text = "STATUS", .style = .{ .dim = true } }, .{ .row_offset = row.*, .col_offset = 8 });
        _ = win.printSegment(.{ .text = "TIME", .style = .{ .dim = true } }, .{ .row_offset = row.*, .col_offset = 16 });
        _ = win.printSegment(.{ .text = "PATH", .style = .{ .dim = true } }, .{ .row_offset = row.*, .col_offset = 24 });
        row.* += 1;

        const count = self.state.request_count;
        if (count == 0) {
            _ = win.printSegment(.{ .text = "No requests yet...", .style = .{ .dim = true } }, .{ .row_offset = row.*, .col_offset = 0 });
            return;
        }

        var i: u32 = 0;
        while (i < height and i + self.scroll_offset < count) : (i += 1) {
            const idx = (self.state.request_head + MAX_REQUESTS - 1 - i - self.scroll_offset) % MAX_REQUESTS;
            const req = &self.state.requests[idx];
            // Pass visual index for buffer allocation (max 20 visible)
            const vis_idx = @min(i, 19);
            self.drawRequest(win, row.* + @as(u16, @intCast(i)), req, vis_idx, win.width);
        }
    }

    fn drawRequest(self: *App, win: vaxis.Window, row: u16, req: *const Request, buf_idx: u32, term_width: u16) void {
        const is_ws = req.connection_type == CONN_WS;
        const is_sse = req.connection_type == CONN_SSE;
        const is_long_lived = is_ws or is_sse;

        // Method (with bounds check)
        const method_len = @min(req.method_len, MAX_METHOD_LEN);
        const method = if (method_len > 0) req.method[0..method_len] else "???";
        const method_color: Color = if (std.mem.eql(u8, method, "GET"))
            C_GREEN
        else if (std.mem.eql(u8, method, "POST"))
            C_BLUE
        else if (std.mem.startsWith(u8, method, "PUT") or std.mem.startsWith(u8, method, "PATCH"))
            C_YELLOW
        else if (std.mem.startsWith(u8, method, "DELETE"))
            C_RED
        else
            .default;

        _ = win.printSegment(.{ .text = method, .style = .{ .fg = method_color } }, .{ .row_offset = row, .col_offset = 0 });

        // Status column - different handling for WS/SSE
        if (is_long_lived) {
            const prefix = if (is_ws) "WS " else "SSE";
            if (req.status > 0) {
                // Completed WS/SSE
                if (req.is_error) {
                    _ = win.printSegment(.{ .text = prefix, .style = .{ .fg = C_RED } }, .{ .row_offset = row, .col_offset = 8 });
                    _ = win.printSegment(.{ .text = " ERR", .style = .{ .fg = C_RED } }, .{ .row_offset = row, .col_offset = 11 });
                } else {
                    _ = win.printSegment(.{ .text = prefix, .style = .{ .fg = C_GREEN } }, .{ .row_offset = row, .col_offset = 8 });
                    _ = win.printSegment(.{ .text = " END", .style = .{ .fg = C_GREEN } }, .{ .row_offset = row, .col_offset = 11 });
                }
            } else {
                // Active WS/SSE - show with activity arrow
                _ = win.printSegment(.{ .text = prefix, .style = .{ .fg = C_MAGENTA } }, .{ .row_offset = row, .col_offset = 8 });
                const arrow = getActivityArrow(req);
                _ = win.printSegment(.{ .text = arrow, .style = .{ .fg = C_MAGENTA } }, .{ .row_offset = row, .col_offset = 12 });
            }
        } else if (req.is_error) {
            _ = win.printSegment(.{ .text = "ERR", .style = .{ .fg = C_RED } }, .{ .row_offset = row, .col_offset = 8 });
        } else if (req.status > 0) {
            const status_color: Color = if (req.status < 300)
                C_GREEN
            else if (req.status < 400)
                C_CYAN
            else if (req.status < 500)
                C_YELLOW
            else
                C_RED;

            // Use persistent buffer indexed by visual row
            const status_str = std.fmt.bufPrint(&self.status_bufs[buf_idx], "{d}", .{req.status}) catch "?";
            _ = win.printSegment(.{ .text = status_str, .style = .{ .fg = status_color } }, .{ .row_offset = row, .col_offset = 8 });
        } else {
            _ = win.printSegment(.{ .text = "...", .style = .{ .dim = true } }, .{ .row_offset = row, .col_offset = 8 });
        }

        // Time column - different handling for WS/SSE and LOCAL
        if (req.is_local) {
            _ = win.printSegment(.{ .text = "LOCAL", .style = .{ .fg = C_MAGENTA } }, .{ .row_offset = row, .col_offset = 16 });
        } else if (!is_long_lived and req.duration_ms > 0) {
            const time_str = if (req.duration_ms < 1000)
                std.fmt.bufPrint(&self.time_bufs[buf_idx], "{d}ms", .{req.duration_ms}) catch "?"
            else
                std.fmt.bufPrint(&self.time_bufs[buf_idx], "{d}s", .{req.duration_ms / 1000}) catch "?";
            _ = win.printSegment(.{ .text = time_str, .style = .{ .fg = C_YELLOW } }, .{ .row_offset = row, .col_offset = 16 });
        }
        // WS/SSE don't show duration

        // Path (with bounds check, dynamic width based on terminal)
        const path_len = @min(req.path_len, MAX_PATH_LEN);
        if (path_len > 0) {
            const path = req.path[0..path_len];
            // PATH column starts at 24, leave 1 char margin
            const max_path: u16 = if (term_width > 25) term_width - 25 else 20;
            const truncated = if (path_len > max_path) path[0..max_path] else path;
            _ = win.printSegment(.{ .text = truncated }, .{ .row_offset = row, .col_offset = 24 });
        }
    }

    fn drawStats(self: *App, win: vaxis.Window, row: u16) void {
        var col: u16 = 0;

        // Total requests
        const total = std.fmt.bufPrint(&self.stats_total_buf, "Requests: {d}", .{self.state.stats_total}) catch "?";
        _ = win.printSegment(.{ .text = total }, .{ .row_offset = row, .col_offset = col });
        col += @intCast(total.len);

        _ = win.printSegment(.{ .text = " | ", .style = .{ .dim = true } }, .{ .row_offset = row, .col_offset = col });
        col += 3;

        // 2xx (green)
        const s2xx = std.fmt.bufPrint(&self.stats_2xx_buf, "2xx: {d}", .{self.state.stats_2xx}) catch "?";
        _ = win.printSegment(.{ .text = s2xx, .style = .{ .fg = C_GREEN } }, .{ .row_offset = row, .col_offset = col });
        col += @intCast(s2xx.len);

        _ = win.printSegment(.{ .text = " | ", .style = .{ .dim = true } }, .{ .row_offset = row, .col_offset = col });
        col += 3;

        // 4xx (yellow)
        const s4xx = std.fmt.bufPrint(&self.stats_4xx_buf, "4xx: {d}", .{self.state.stats_4xx}) catch "?";
        _ = win.printSegment(.{ .text = s4xx, .style = .{ .fg = C_YELLOW } }, .{ .row_offset = row, .col_offset = col });
        col += @intCast(s4xx.len);

        _ = win.printSegment(.{ .text = " | ", .style = .{ .dim = true } }, .{ .row_offset = row, .col_offset = col });
        col += 3;

        // 5xx (red)
        const s5xx = std.fmt.bufPrint(&self.stats_5xx_buf, "5xx: {d}", .{self.state.stats_5xx}) catch "?";
        _ = win.printSegment(.{ .text = s5xx, .style = .{ .fg = C_RED } }, .{ .row_offset = row, .col_offset = col });
    }
};

// ============================================================================
// TUI Thread
// ============================================================================

var tui_thread: ?std.Thread = null;
var should_stop = std.atomic.Value(bool).init(false);
var global_state: ?*State = null;

fn tuiThreadMain(state: *State) void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    // Buffer for TTY
    var tty_buffer: [1024]u8 = .{0} ** 1024;

    // Initialize TTY
    var tty = vaxis.Tty.init(&tty_buffer) catch return;
    defer tty.deinit();

    // Set non-blocking mode for reads
    var fl_flags = std.posix.fcntl(tty.fd, std.posix.F.GETFL, 0) catch return;
    fl_flags |= 1 << @bitOffsetOf(std.posix.O, "NONBLOCK");
    _ = std.posix.fcntl(tty.fd, std.posix.F.SETFL, fl_flags) catch return;

    // Initialize Vaxis
    var vx = vaxis.Vaxis.init(allocator, .{}) catch return;
    defer vx.deinit(allocator, tty.writer());

    // Enter alternate screen and hide cursor
    const writer = tty.writer();
    vx.enterAltScreen(writer) catch return;
    _ = writer.write("\x1b[?25l") catch {}; // Hide cursor
    defer {
        // Restore cursor and exit alternate screen
        _ = writer.write("\x1b[?25h") catch {}; // Show cursor
        vx.exitAltScreen(writer) catch {};
    }

    // Get initial size
    const winsize = vaxis.Tty.getWinsize(tty.fd) catch return;
    vx.resize(allocator, tty.writer(), winsize) catch return;

    var app = App.init(state);

    // Parser for input
    var parser: vaxis.Parser = .{};
    var read_buf: [256]u8 = .{0} ** 256;

    while (!should_stop.load(.acquire) and !app.should_quit) {
        // Non-blocking read (returns EAGAIN if no data)
        const n = tty.read(&read_buf) catch 0;
        if (n > 0) {
            var seq_start: usize = 0;
            while (seq_start < n) {
                const result = parser.parse(read_buf[seq_start..n], null) catch break;
                if (result.n == 0) break;
                seq_start += result.n;

                if (result.event) |event| {
                    switch (event) {
                        .key_press => |key| app.handleKey(key),
                        .winsize => |ws| {
                            vx.resize(allocator, tty.writer(), ws) catch {};
                        },
                        else => {},
                    }
                }
            }
        }

        // Check state version
        const current_version = state.version.load(.acquire);
        if (current_version != app.last_version) {
            app.last_version = current_version;
        }

        // Render
        const win = vx.window();
        app.render(win);
        vx.render(tty.writer()) catch {};

        // Sleep ~60fps
        std.Thread.sleep(16 * std.time.ns_per_ms);
    }

    // Signal that TUI has stopped (for tui_is_running check)
    should_stop.store(true, .release);
}

// ============================================================================
// C ABI Exports
// ============================================================================

pub export fn tui_init(state: *State) bool {
    if (tui_thread != null) return false;

    global_state = state;
    should_stop.store(false, .release);

    tui_thread = std.Thread.spawn(.{}, tuiThreadMain, .{state}) catch return false;
    return true;
}

pub export fn tui_shutdown() void {
    should_stop.store(true, .release);
    if (tui_thread) |t| {
        t.join();
        tui_thread = null;
    }
    global_state = null;
}

pub export fn tui_is_running() bool {
    return tui_thread != null and !should_stop.load(.acquire);
}

pub export fn tui_state_size() usize {
    return @sizeOf(State);
}

pub export fn tui_request_size() usize {
    return @sizeOf(Request);
}

// Request field offsets
pub export fn req_offset_id() usize {
    return @offsetOf(Request, "id");
}
pub export fn req_offset_method() usize {
    return @offsetOf(Request, "method");
}
pub export fn req_offset_method_len() usize {
    return @offsetOf(Request, "method_len");
}
pub export fn req_offset_path() usize {
    return @offsetOf(Request, "path");
}
pub export fn req_offset_path_len() usize {
    return @offsetOf(Request, "path_len");
}
pub export fn req_offset_status() usize {
    return @offsetOf(Request, "status");
}
pub export fn req_offset_duration() usize {
    return @offsetOf(Request, "duration_ms");
}
pub export fn req_offset_is_error() usize {
    return @offsetOf(Request, "is_error");
}
pub export fn req_offset_is_local() usize {
    return @offsetOf(Request, "is_local");
}
pub export fn req_offset_conn_type() usize {
    return @offsetOf(Request, "connection_type");
}
pub export fn req_offset_last_incoming() usize {
    return @offsetOf(Request, "last_incoming");
}
pub export fn req_offset_last_outgoing() usize {
    return @offsetOf(Request, "last_outgoing");
}

// State field offsets
pub export fn state_offset_connected() usize {
    return @offsetOf(State, "connected");
}
pub export fn state_offset_reconnecting() usize {
    return @offsetOf(State, "reconnecting");
}
pub export fn state_offset_reconnect_attempt() usize {
    return @offsetOf(State, "reconnect_attempt");
}
pub export fn state_offset_public_url() usize {
    return @offsetOf(State, "public_url");
}
pub export fn state_offset_public_url_len() usize {
    return @offsetOf(State, "public_url_len");
}
pub export fn state_offset_local_port() usize {
    return @offsetOf(State, "local_port");
}
pub export fn state_offset_error_message() usize {
    return @offsetOf(State, "error_message");
}
pub export fn state_offset_error_len() usize {
    return @offsetOf(State, "error_len");
}
pub export fn state_offset_requests() usize {
    return @offsetOf(State, "requests");
}
pub export fn state_offset_request_count() usize {
    return @offsetOf(State, "request_count");
}
pub export fn state_offset_request_head() usize {
    return @offsetOf(State, "request_head");
}
pub export fn state_offset_stats_total() usize {
    return @offsetOf(State, "stats_total");
}
pub export fn state_offset_stats_2xx() usize {
    return @offsetOf(State, "stats_2xx");
}
pub export fn state_offset_stats_4xx() usize {
    return @offsetOf(State, "stats_4xx");
}
pub export fn state_offset_stats_5xx() usize {
    return @offsetOf(State, "stats_5xx");
}
pub export fn state_offset_stats_avg_ms() usize {
    return @offsetOf(State, "stats_avg_ms");
}
pub export fn state_offset_version() usize {
    return @offsetOf(State, "version");
}
