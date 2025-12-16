# fast-ngrok

Simple single-user ngrok alternative with WebSocket tunneling and Caddy integration.

## Features

- WebSocket-based tunneling
- Wildcard subdomain support (`*.tunnel.example.com`)
- htop-like TUI for monitoring requests
- Caddy integration for automatic route management
- Pre-shared API key authentication

## Installation

```bash
git clone https://github.com/alex-mextner/fast-ngrok.git
cd fast-ngrok
bun install
```

## Server Setup (VPS)

1. Run interactive setup:
```bash
bun run src/cli/index.ts init
```
This will ask for:
- Your domain (e.g., `tunnel.example.com`)
- Server port (default: 3100)
- DNS provider for wildcard SSL (Cloudflare, DigitalOcean, Hetzner, etc.)

Generates `.env` and `deploy/Caddyfile`.

2. Start server:
```bash
bun run server
```

## Client Setup (Local machine)

1. Configure client:
```bash
bunx fast-ngrok auth
```

2. Start tunnel:
```bash
bunx fast-ngrok http 3000
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `fast-ngrok http <port>` | Expose local HTTP server |
| `fast-ngrok auth` | Configure server URL and API key |
| `fast-ngrok init` | Generate API key (run on server) |

## TUI Controls

- `q` or `Ctrl+C` - quit
- `Up/Down` - scroll request list

## Architecture

```
[Client]                    [Server/VPS]                [Internet]
   |                             |                          |
   | WebSocket tunnel            |                          |
   |<--------------------------->|                          |
   |                             |                          |
   | localhost:3000              | Caddy (wildcard SSL)     |
   |                             |<------------------------>|
   |                             | *.tunnel.example.com     |
```

## Requirements

- Bun 1.0+
- Caddy 2.0+ with Admin API enabled
- Wildcard DNS record (`*.tunnel.example.com -> VPS IP`)
- Wildcard SSL certificate (via DNS challenge)
