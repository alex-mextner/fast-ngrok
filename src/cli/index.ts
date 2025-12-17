#!/usr/bin/env bun

import { parseArgs } from "util";
import { httpCommand } from "./commands/http.ts";
import { authCommand } from "./commands/auth.ts";
import { initServerCommand } from "./commands/init-server.ts";
import { updateServiceCommand } from "./commands/update-service.ts";

const HELP = `
fast-ngrok - Simple tunnel to localhost

Commands:
  init-server     Setup server (VPS, requires sudo)
  update-service  Update systemd service (VPS, requires sudo)
  server          Run tunnel server daemon (VPS)
  auth            Configure credentials (client)
  http <port>     Start tunnel to local server (client)

Options:
  --subdomain <name>   Use custom subdomain (e.g., --subdomain my-app)
  --no-local-shortcut  Disable local shortcut (macOS only)

Usage:
  # 1. Setup server (on VPS)
  sudo bunx fast-ngrok init-server

  # 2. Configure client (on local machine)
  bunx fast-ngrok auth

  # 3. Start tunnel
  bunx fast-ngrok http 3000

  # 4. With custom subdomain
  bunx fast-ngrok http 3000 --subdomain my-app
`;

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      "no-local-shortcut": { type: "boolean" },
      subdomain: { type: "string" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (values.version) {
    // Use import.meta.dir to find package.json relative to this script
    const pkgPath = new URL("../../package.json", import.meta.url).pathname;
    const pkg = await Bun.file(pkgPath).json();
    console.log(`fast-ngrok v${pkg.version}`);
    process.exit(0);
  }

  const command = positionals[0];

  switch (command) {
    case "http":
      await httpCommand(positionals.slice(1), {
        noLocalShortcut: values["no-local-shortcut"] ?? false,
        subdomain: values.subdomain,
      });
      break;

    case "auth":
      await authCommand();
      break;

    case "init-server":
      await initServerCommand();
      break;

    case "update-service":
      await updateServiceCommand();
      break;

    case "server":
      // Dynamic import to avoid loading server code on client
      await import("../server/index.ts");
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
