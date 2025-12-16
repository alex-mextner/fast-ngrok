#!/usr/bin/env bun

import { parseArgs } from "util";
import { httpCommand } from "./commands/http.ts";
import { authCommand } from "./commands/auth.ts";
import { initCommand } from "./commands/init.ts";

const HELP = `
fast-ngrok - Simple tunnel to localhost

Commands:
  http <port>  Expose local HTTP server
  auth         Configure server URL and API key
  init         Generate API key (run on server)

Usage:
  bunx fast-ngrok http 3000
  bunx fast-ngrok auth
  bunx fast-ngrok init

Examples:
  # Start tunnel to local dev server
  bunx fast-ngrok http 3000

  # Configure client with server credentials
  bunx fast-ngrok auth

  # Generate API key on server
  bunx fast-ngrok init
`;

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
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
      await httpCommand(positionals.slice(1));
      break;

    case "auth":
      await authCommand();
      break;

    case "init":
      await initCommand();
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
