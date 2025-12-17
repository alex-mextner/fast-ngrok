# fast-ngrok

Simple single-user ngrok alternative with WebSocket tunneling and Caddy integration.

## Features

- WebSocket-based tunneling
- Wildcard subdomain support (`*.tunnel.example.com`)
- htop-like TUI for monitoring requests
- Caddy integration for automatic route management
- Pre-shared API key authentication

| 1. Server setup | 2. Client setup |
| --------------- | --------------- |
| <img width="700" alt="Screenshot 2025-12-16 at 19 29 26" src="https://github.com/user-attachments/assets/6bbdfc9f-ed64-49c0-958f-e266833a4397" /> | <img width="450" alt="image" src="https://github.com/user-attachments/assets/f93e58a9-7dbe-4bfa-a1b2-2cccaf5a3dd2" /> <img width="450" alt="image" src="https://github.com/user-attachments/assets/9eccf752-0804-4937-83dc-3bec1298a38b" /> |


## Installation

```bash
git clone https://github.com/alex-mextner/fast-ngrok.git
cd fast-ngrok
bun install
```

## Server Setup (VPS)

Run interactive setup (requires sudo):
```bash
sudo bunx fast-ngrok init-server
```

This will:

- Install fast-ngrok globally
- Ask for domain, port, DNS provider
- Generate `.env` and Caddyfile
- Build Caddy with DNS plugin (for wildcard SSL)
- Create DNS wildcard record (Cloudflare)
- Setup and start systemd services

## Client Setup (Local machine)

Configure client:

```bash
bunx fast-ngrok auth
```

Start tunnel:

```bash
bunx fast-ngrok http 3000
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `fast-ngrok init-server` | Setup server (VPS, requires sudo) |
| `fast-ngrok server` | Run tunnel server daemon |
| `fast-ngrok auth` | Configure server URL and API key |
| `fast-ngrok http <port>` | Expose local HTTP server |

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
