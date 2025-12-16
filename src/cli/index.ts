#!/usr/bin/env bun

import { parseArgs } from "util";
import { httpCommand } from "./commands/http.ts";
import { authCommand } from "./commands/auth.ts";
import { initServerCommand } from "./commands/init-server.ts";

const HELP = `
fast-ngrok - Simple tunnel to localhost

Commands:
  http <port>   Expose local HTTP server
  auth          Configure server URL and API key
  init-server   Install and configure server (run on VPS)

Options (for http command):
  --no-local-shortcut  Disable local shortcut (macOS only)
                       By default, local requests bypass tunnel

Usage:
  bunx fast-ngrok http 3000
  bunx fast-ngrok auth
  bunx fast-ngrok init-server   # Run on server with sudo

Examples:
  # Start tunnel to local dev server
  bunx fast-ngrok http 3000

  # Configure client with server credentials
  bunx fast-ngrok auth

  # Setup server (run on VPS as root)
  sudo bunx fast-ngrok init-server
`;

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      "no-local-shortcut": { type: "boolean" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (values.version) {
    const pkg = await Bun.file("./package.json").json();
    console.log(`fast-ngrok v${pkg.version}`);
    process.exit(0);
  }

  const command = positionals[0];

  switch (command) {
    case "http":
      await httpCommand(positionals.slice(1), {
        noLocalShortcut: values["no-local-shortcut"] ?? false,
      });
      break;

    case "auth":
      await authCommand();
      break;

    case "init-server":
      await initServerCommand();
      break;

    default:
      console.log(HELP);
      process.exit(command ? 1 : 0);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
