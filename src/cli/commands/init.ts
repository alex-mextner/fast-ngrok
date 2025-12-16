import { join } from "path";
import terminalKit from "terminal-kit";

const term = terminalKit.terminal;

interface InitConfig {
  domain: string;
  port: number;
  dnsProvider: string;
  apiToken?: string;
}

const DNS_PROVIDERS = [
  { name: "Cloudflare", value: "cloudflare", envVar: "CF_API_TOKEN" },
  { name: "DigitalOcean", value: "digitalocean", envVar: "DO_AUTH_TOKEN" },
  { name: "Hetzner", value: "hetzner", envVar: "HETZNER_API_KEY" },
  { name: "Vultr", value: "vultr", envVar: "VULTR_API_KEY" },
  { name: "Route53 (AWS)", value: "route53", envVar: "AWS_ACCESS_KEY_ID" },
  { name: "Manual (I'll configure DNS myself)", value: "manual", envVar: null },
];

export async function initCommand(): Promise<void> {
  term.clear();
  term.bold.cyan("Fast-ngrok Server Initialization\n\n");

  // Check if already initialized
  const envPath = join(process.cwd(), ".env");
  const envFile = Bun.file(envPath);
  if (await envFile.exists()) {
    const content = await envFile.text();
    if (content.includes("API_KEY=")) {
      term.yellow("Warning: .env already contains API_KEY\n");
      term.white("Do you want to reconfigure? ");

      const confirmed = await yesNo();
      if (!confirmed) {
        term("\nAborted.\n");
        process.exit(0);
      }
      term("\n");
    }
  }

  // Collect configuration
  const config = await collectConfig();

  // Generate files
  await generateFiles(config);

  term.green("\n✓ Configuration complete!\n\n");

  term.white("Generated files:\n");
  term.gray("  • .env - Server configuration\n");
  term.gray("  • deploy/Caddyfile - Caddy configuration\n");

  term.white("\nNext steps:\n");
  term.gray("  1. ");
  term.white("Configure DNS: ");
  term.cyan(`*.${config.domain} → your server IP\n`);

  if (config.dnsProvider !== "manual") {
    const provider = DNS_PROVIDERS.find(p => p.value === config.dnsProvider);
    term.gray("  2. ");
    term.white(`Set ${provider?.envVar} in .env\n`);
    term.gray("  3. ");
  } else {
    term.gray("  2. ");
  }
  term.white("Install Caddy with DNS plugin (see below)\n");
  term.gray(`  ${config.dnsProvider !== "manual" ? "4" : "3"}. `);
  term.white("Start: ");
  term.cyan("bun run server\n");

  if (config.dnsProvider !== "manual") {
    term.white("\nCaddy installation with DNS plugin:\n");
    term.gray(`  xcaddy build --with github.com/caddy-dns/${config.dnsProvider}\n`);
  }

  term("\n");
  process.exit(0);
}

async function collectConfig(): Promise<InitConfig> {
  // Domain
  term.white("Enter your domain (e.g., tunnel.example.com): ");
  const domain = await inputField("tunnel.example.com");
  term("\n");

  // Port
  term.white("Server port [3100]: ");
  const portStr = await inputField("3100");
  const port = parseInt(portStr, 10) || 3100;
  term("\n");

  // DNS Provider
  term.white("\nSelect DNS provider for wildcard SSL:\n");
  term.gray(`(Required for automatic HTTPS on *.${domain})\n\n`);

  const dnsProviderIndex = await selectMenu(
    DNS_PROVIDERS.map(p => p.name),
    0
  );
  const selectedProvider = DNS_PROVIDERS[dnsProviderIndex];
  if (!selectedProvider) {
    term.red("Invalid selection\n");
    process.exit(1);
  }
  term("\n");

  let apiToken: string | undefined;

  if (selectedProvider.value === "manual") {
    term.yellow("\nManual DNS configuration:\n");
    term.gray("  You'll need to:\n");
    term.gray(`  1. Get a wildcard certificate for *.${domain}\n`);
    term.gray("  2. Configure Caddy to use it manually\n");
    term.gray("  3. Or use a different ACME DNS challenge method\n\n");
  } else {
    term.white(`\nEnter ${selectedProvider.envVar} (optional, can set later): `);
    apiToken = await inputField("");
    term("\n");
  }

  return {
    domain,
    port,
    dnsProvider: selectedProvider.value,
    apiToken: apiToken || undefined,
  };
}

async function generateFiles(config: InitConfig): Promise<void> {
  const apiKey = generateApiKey();
  const provider = DNS_PROVIDERS.find(p => p.value === config.dnsProvider);

  // Generate .env
  let envContent = `# Fast-ngrok configuration (generated)
API_KEY=${apiKey}
BASE_DOMAIN=${config.domain}
TUNNEL_PORT=${config.port}
CADDY_ADMIN_URL=http://localhost:2019
`;

  if (provider?.envVar && config.apiToken) {
    envContent += `${provider.envVar}=${config.apiToken}\n`;
  } else if (provider?.envVar) {
    envContent += `# ${provider.envVar}=your-token-here\n`;
  }

  await Bun.write(join(process.cwd(), ".env"), envContent);

  // Generate Caddyfile
  const caddyfile = generateCaddyfile(config);
  await Bun.$`mkdir -p deploy`;
  await Bun.write(join(process.cwd(), "deploy", "Caddyfile"), caddyfile);
}

function generateCaddyfile(config: InitConfig): string {
  const provider = DNS_PROVIDERS.find(p => p.value === config.dnsProvider);

  let tlsBlock: string;

  if (config.dnsProvider === "manual") {
    tlsBlock = `    # Manual TLS configuration
    # Option 1: Use your own certificate
    # tls /path/to/cert.pem /path/to/key.pem

    # Option 2: Use a different DNS provider
    # tls {
    #     dns <provider> {env.<TOKEN_VAR>}
    # }`;
  } else if (config.dnsProvider === "route53") {
    tlsBlock = `    tls {
        dns route53 {
            access_key_id {env.AWS_ACCESS_KEY_ID}
            secret_access_key {env.AWS_SECRET_ACCESS_KEY}
            region {env.AWS_REGION}
        }
    }`;
  } else {
    tlsBlock = `    tls {
        dns ${config.dnsProvider} {env.${provider?.envVar}}
    }`;
  }

  return `# Fast-ngrok Caddy configuration
# Generated for: ${config.domain}
#
# Install Caddy with DNS plugin:
#   xcaddy build --with github.com/caddy-dns/${config.dnsProvider}
#
# Run:
#   caddy run --config deploy/Caddyfile

{
    # Enable Admin API for dynamic route management
    admin localhost:2019
}

# Wildcard domain for tunnels
*.${config.domain} {
${tlsBlock}

    # Proxy to fast-ngrok server
    reverse_proxy localhost:${config.port}
}

# Main domain (optional status page)
${config.domain} {
${tlsBlock}

    handle /__tunnel__/* {
        reverse_proxy localhost:${config.port}
    }

    handle {
        respond "fast-ngrok tunnel server" 200
    }
}
`;
}

function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// terminal-kit helpers
async function inputField(defaultValue: string): Promise<string> {
  return new Promise((resolve) => {
    term.inputField(
      { default: defaultValue },
      (_error: Error | undefined, input: string | undefined) => {
        resolve(input || defaultValue);
      }
    );
  });
}

async function selectMenu(items: string[], defaultIndex: number): Promise<number> {
  return new Promise((resolve) => {
    term.singleColumnMenu(
      items,
      { selectedIndex: defaultIndex },
      (_error: Error | undefined, response: { selectedIndex: number }) => {
        resolve(response.selectedIndex);
      }
    );
  });
}

async function yesNo(): Promise<boolean> {
  return new Promise((resolve) => {
    term.yesOrNo({ yes: ["y", "Y"], no: ["n", "N"] }, (_error: Error | undefined, result: boolean) => {
      resolve(result);
    });
  });
}
