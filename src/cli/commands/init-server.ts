import { join } from "path";
import { homedir } from "os";
import terminalKit from "terminal-kit";

const term = terminalKit.terminal;

interface InitConfig {
  domain: string;
  port: number;
  dnsProvider: string;
  apiToken?: string;
  installDir: string;
}

const DNS_PROVIDERS = [
  { name: "Cloudflare", value: "cloudflare", envVar: "CF_API_TOKEN" },
  { name: "DigitalOcean", value: "digitalocean", envVar: "DO_AUTH_TOKEN" },
  { name: "Hetzner", value: "hetzner", envVar: "HETZNER_API_KEY" },
  { name: "Vultr", value: "vultr", envVar: "VULTR_API_KEY" },
  { name: "Route53 (AWS)", value: "route53", envVar: "AWS_ACCESS_KEY_ID" },
  { name: "Manual (I'll configure DNS myself)", value: "manual", envVar: null },
];

const DEFAULT_INSTALL_DIR = "/opt/fast-ngrok";

export async function initServerCommand(): Promise<void> {
  term.clear();
  term.bold.cyan("Fast-ngrok Server Setup\n\n");

  // Check if running as root (required for systemd)
  const isRoot = process.getuid?.() === 0;
  if (!isRoot) {
    term.yellow("Warning: Not running as root. You may need sudo for systemd setup.\n\n");
  }

  // Collect configuration
  const config = await collectConfig();

  // Step 1: Install package globally
  term.white("\n[1/4] Installing fast-ngrok globally...\n");
  await installGlobalPackage();

  // Step 2: Create install directory and config files
  term.white("\n[2/4] Creating configuration...\n");
  await createInstallDirectory(config);
  await generateFiles(config);

  // Step 3: Generate and install systemd service
  term.white("\n[3/4] Setting up systemd service...\n");
  await setupSystemdService(config);

  // Step 4: Show Caddy instructions (only for non-manual)
  if (config.dnsProvider !== "manual") {
    term.white("\n[4/4] Caddy setup required\n");
    term.yellow("\nYou need to install Caddy with DNS plugin:\n");
    term.cyan(`  xcaddy build --with github.com/caddy-dns/${config.dnsProvider}\n`);
    term.gray("  sudo mv caddy /usr/bin/caddy\n\n");
  } else {
    term.white("\n[4/4] Manual TLS configuration required\n");
    term.gray("  See Caddyfile for instructions\n\n");
  }

  // Final summary
  term.green("\n✓ Setup complete!\n\n");

  term.white("Configuration:\n");
  term.gray(`  • Install dir: ${config.installDir}\n`);
  term.gray(`  • .env: ${join(config.installDir, ".env")}\n`);
  term.gray(`  • Caddyfile: ${join(config.installDir, "Caddyfile")}\n`);

  term.white("\nManual steps remaining:\n");
  term.gray("  1. ");
  term.white("Configure DNS: ");
  term.cyan(`*.${config.domain} → this server IP\n`);

  if (config.dnsProvider !== "manual") {
    const provider = DNS_PROVIDERS.find(p => p.value === config.dnsProvider);
    if (provider?.envVar && !config.apiToken) {
      term.gray("  2. ");
      term.white(`Set ${provider.envVar} in ${join(config.installDir, ".env")}\n`);
    }
  }

  term.white("\nService commands:\n");
  term.cyan("  sudo systemctl start fast-ngrok\n");
  term.cyan("  sudo systemctl status fast-ngrok\n");
  term.cyan("  sudo journalctl -u fast-ngrok -f\n");

  // Show generated API key
  const envContent = await Bun.file(join(config.installDir, ".env")).text();
  const apiKeyMatch = envContent.match(/API_KEY=(\S+)/);
  if (apiKeyMatch) {
    term.white("\nAPI Key (save this for client configuration):\n");
    term.bold.yellow(`  ${apiKeyMatch[1]}\n`);
  }

  term("\n");
  process.exit(0);
}

async function collectConfig(): Promise<InitConfig> {
  // Install directory
  term.white(`Install directory [${DEFAULT_INSTALL_DIR}]: `);
  const installDir = await inputField(DEFAULT_INSTALL_DIR);
  term("\n");

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
    term.yellow("\nManual TLS configuration selected.\n");
    term.gray("You'll need to configure certificates in Caddyfile.\n\n");
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
    installDir,
  };
}

async function hasBun(): Promise<boolean> {
  try {
    const result = await Bun.$`which bun`.quiet();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function installGlobalPackage(): Promise<void> {
  const useBun = await hasBun();
  const pkgManager = useBun ? "bun" : "npm";

  term.gray(`  Using ${pkgManager}...\n`);

  try {
    if (useBun) {
      await Bun.$`bun add -g fast-ngrok`.quiet();
    } else {
      await Bun.$`npm install -g fast-ngrok`.quiet();
    }
    term.green(`  ✓ Installed globally via ${pkgManager}\n`);
  } catch (error) {
    term.yellow(`  ⚠ Global install failed (may already be installed)\n`);
  }
}

async function createInstallDirectory(config: InitConfig): Promise<void> {
  try {
    await Bun.$`mkdir -p ${config.installDir}`.quiet();
    term.green(`  ✓ Created ${config.installDir}\n`);
  } catch (error) {
    term.red(`  ✗ Failed to create directory: ${error}\n`);
    process.exit(1);
  }
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

  const envPath = join(config.installDir, ".env");
  await Bun.write(envPath, envContent);
  term.green(`  ✓ Created ${envPath}\n`);

  // Generate Caddyfile
  const caddyfile = generateCaddyfile(config);
  const caddyPath = join(config.installDir, "Caddyfile");
  await Bun.write(caddyPath, caddyfile);
  term.green(`  ✓ Created ${caddyPath}\n`);
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

async function setupSystemdService(config: InitConfig): Promise<void> {
  const useBun = await hasBun();
  const runtime = useBun ? "bun" : "node";
  const runtimePath = useBun ? "/usr/bin/bun" : "/usr/bin/node";

  // Try to find actual path
  let execPath = runtimePath;
  try {
    const result = await Bun.$`which ${runtime}`.text();
    execPath = result.trim() || runtimePath;
  } catch {
    // Use default
  }

  const serviceContent = `[Unit]
Description=Fast-ngrok Tunnel Server
After=network.target caddy.service
Wants=caddy.service

[Service]
Type=simple
User=root
WorkingDirectory=${config.installDir}
EnvironmentFile=${config.installDir}/.env
ExecStart=${execPath} /usr/local/bin/fast-ngrok server
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

  const servicePath = "/etc/systemd/system/fast-ngrok.service";

  try {
    await Bun.write(servicePath, serviceContent);
    term.green(`  ✓ Created ${servicePath}\n`);

    // Reload systemd
    await Bun.$`systemctl daemon-reload`.quiet();
    term.green("  ✓ Reloaded systemd\n");

    // Enable service
    await Bun.$`systemctl enable fast-ngrok`.quiet();
    term.green("  ✓ Enabled fast-ngrok service\n");
  } catch (error) {
    term.yellow(`  ⚠ Systemd setup requires root permissions\n`);
    term.gray(`  Run with sudo or manually create:\n`);
    term.gray(`  ${servicePath}\n`);
  }
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
