# fast-ngrok

Single-user ngrok alternative with WebSocket tunneling and Caddy integration.

## Setup

### Server (VPS)

```bash
# 1. Install
bun install

# 2. Run interactive setup
bun run src/cli/index.ts init
# → Asks for domain, port, DNS provider
# → Generates .env and deploy/Caddyfile

# 3. Start server
bun run server
# or with hot reload:
bun run dev
```

### Client (local machine)

На клиенте используется `bunx fast-ngrok` (или `npx fast-ngrok`).

```bash
# 1. Configure credentials (one time)
bunx fast-ngrok auth
# → Asks for server URL and API key
# → Saves to ~/.fast-ngrok/config.json

# 2. Start tunnel
bunx fast-ngrok http 3000
# → Opens tunnel to localhost:3000
# → Shows TUI with real-time requests
```

### Development

```bash
bun run --bun tsc --noEmit      # Type check
```

## Tech Stack

- **Runtime**: Bun (TypeScript, no transpilation)
- **Server**: `Bun.serve()` with native WebSocket support
- **TUI**: terminal-kit (pure JS, no native deps)
- **Proxy**: Caddy with Admin API for dynamic routes
- **Auth**: Pre-shared API key (constant-time comparison)

## Architecture

```plain
┌─────────────┐         WebSocket          ┌─────────────┐
│   CLI       │◄──────────────────────────►│   Server    │
│ (localhost) │    JSON protocol           │   (VPS)     │
└──────┬──────┘                            └──────┬──────┘
       │                                          │
       ▼                                          ▼
┌─────────────┐                            ┌─────────────┐
│ Local app   │                            │   Caddy     │
│ :3000       │                            │ *.domain    │
└─────────────┘                            └─────────────┘
```

**Flow:**

1. CLI connects to server via WebSocket with API key
2. Server generates random subdomain (e.g., `brave-fox-a1b2`)
3. Server registers route in Caddy via Admin API
4. HTTP request to `brave-fox-a1b2.tunnel.example.com` → Caddy → Server
5. Server wraps request in JSON, sends via WebSocket to CLI
6. CLI forwards to `localhost:PORT`, gets response
7. CLI sends response back via WebSocket
8. Server responds to original HTTP request

## WebSocket Protocol

Server → Client:

```typescript
{ type: "connected", subdomain: string, publicUrl: string }
{ type: "http_request", requestId: string, method: string, path: string, headers: Record<string, string>, body?: string }
{ type: "ping" }
{ type: "error", message: string }
```

Client → Server:

```typescript
{ type: "http_response", requestId: string, status: number, headers: Record<string, string>, body: string }
{ type: "pong" }
```

## Project Structure

```plain
src/
├── server/                 # VPS server
│   ├── index.ts            # Bun.serve with WebSocket upgrade
│   ├── tunnel-manager.ts   # Map<subdomain, WebSocket>, request routing
│   ├── caddy-api.ts        # POST/DELETE routes via localhost:2019
│   ├── subdomain.ts        # adjective-noun-xxxx generator
│   └── auth.ts             # Constant-time API key verification
├── cli/
│   ├── index.ts            # Command router (parseArgs)
│   ├── commands/
│   │   ├── http.ts         # Main tunnel command
│   │   ├── auth.ts         # Interactive credentials setup
│   │   └── init.ts         # API key generation
│   ├── tunnel-client.ts    # WebSocket with exponential backoff reconnect
│   ├── local-proxy.ts      # fetch() to localhost
│   ├── config.ts           # ~/.fast-ngrok/config.json
│   └── tui/
│       └── index.ts        # terminal-kit real-time UI
└── shared/
    ├── protocol.ts         # Message type definitions
    └── types.ts            # Config, RequestInfo types
```

## Configuration

Server (.env):

- `API_KEY` - Pre-shared authentication key
- `BASE_DOMAIN` - Wildcard domain (e.g., `tunnel.example.com`)
- `TUNNEL_PORT` - Server port (default `3100`)
- `CADDY_ADMIN_URL` - Caddy Admin API (default `http://localhost:2019`)

Client (~/.fast-ngrok/config.json):

- `serverUrl` - Server URL (e.g., `https://tunnel.example.com`)
- `apiKey` - API key from server

## Caddy Setup

Requires wildcard DNS and SSL via DNS challenge:

```plain
*.tunnel.example.com {
    tls {
        dns cloudflare {env.CF_API_TOKEN}
    }
    reverse_proxy localhost:3100
}
```

Caddy Admin API must be enabled (default `localhost:2019`).

## Edge Cases

- **Reconnection**: Exponential backoff 1s → 2s → 4s → ... → 30s max, 10 attempts
- **Request timeout**: 30s server-side, returns 504
- **Large bodies**: Buffered (streaming planned for future)
- **Multiple tunnels**: Separate terminal sessions, each gets own subdomain

## Bun-specific

- `Bun.serve()` with native WebSocket
- `Bun.file()` for file operations
- `Bun.$` for shell commands
- Auto-loads .env (no dotenv needed)
