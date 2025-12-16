import { join } from "node:path";
import terminalKit from "terminal-kit";

const term = terminalKit.terminal;

interface InitConfig {
  domain: string;
  port: number;
  dnsProvider: string;
  apiToken?: string;
  installDir: string;
  serverIp?: string;
}

interface DnsProvider {
  name: string;
  value: string;
  envVar: string | null;
  caddyModule: string | null;
}

const DNS_PROVIDERS: DnsProvider[] = [
  { name: "Cloudflare", value: "cloudflare", envVar: "CF_API_TOKEN", caddyModule: "dns.providers.cloudflare" },
  { name: "DigitalOcean", value: "digitalocean", envVar: "DO_AUTH_TOKEN", caddyModule: "dns.providers.digitalocean" },
  { name: "Hetzner", value: "hetzner", envVar: "HETZNER_API_KEY", caddyModule: "dns.providers.hetzner" },
  { name: "Vultr", value: "vultr", envVar: "VULTR_API_KEY", caddyModule: "dns.providers.vultr" },
  { name: "Route53 (AWS)", value: "route53", envVar: "AWS_ACCESS_KEY_ID", caddyModule: "dns.providers.route53" },
  { name: "Manual (I'll configure DNS myself)", value: "manual", envVar: null, caddyModule: null },
];

const DEFAULT_INSTALL_DIR = "/opt/fast-ngrok";

async function loadExistingEnv(installDir: string): Promise<Record<string, string> | null> {
  try {
    const envPath = join(installDir, ".env");
    const envFile = Bun.file(envPath);
    if (!await envFile.exists()) return null;

    const content = await envFile.text();
    const env: Record<string, string> = {};

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      env[key] = value;
    }

    return Object.keys(env).length > 0 ? env : null;
  } catch {
    return null;
  }
}

export async function initServerCommand(): Promise<void> {
  term.clear();
  term.bold.cyan("Fast-ngrok Server Setup\n\n");

  // Check if running as root (required for systemd)
  const isRoot = process.getuid?.() === 0;
  if (!isRoot) {
    term.red("Error: This command requires root permissions.\n");
    term.white("Run with: ");
    term.cyan("sudo bunx fast-ngrok init-server\n\n");
    process.exit(1);
  }

  // Collect configuration
  const config = await collectConfig();

  const totalSteps = config.dnsProvider === "manual" ? 4 : 6;
  let step = 0;

  // Step 1: Install package globally
  step++;
  term.white(`\n[${step}/${totalSteps}] Installing fast-ngrok globally...\n`);
  await installGlobalPackage();

  // Step 2: Create install directory and config files
  step++;
  term.white(`\n[${step}/${totalSteps}] Creating configuration...\n`);
  await createInstallDirectory(config);
  await generateFiles(config);

  // Step 3: Setup Caddy (for non-manual)
  if (config.dnsProvider !== "manual") {
    step++;
    term.white(`\n[${step}/${totalSteps}] Setting up Caddy...\n`);
    await setupCaddy(config);
  }

  // Step 4: Create DNS wildcard record (for non-manual with token)
  if (config.dnsProvider !== "manual" && config.apiToken) {
    step++;
    term.white(`\n[${step}/${totalSteps}] Creating DNS wildcard record...\n`);
    await createDnsRecord(config);
  }

  // Step 5: Generate and install systemd service
  step++;
  term.white(`\n[${step}/${totalSteps}] Setting up systemd service...\n`);
  await setupSystemdService(config);

  // Step 6: Start services and show logs
  step++;
  term.white(`\n[${step}/${totalSteps}] Starting services...\n`);
  await startServices(config);

  // Final summary
  term.green("\n✓ Setup complete!\n\n");

  term.white("Configuration:\n");
  term.gray(`  • Install dir: ${config.installDir}\n`);
  term.gray(`  • Domain: ${config.domain}\n`);
  term.gray(`  • Port: ${config.port}\n`);

  // Show remaining manual steps if any
  const manualSteps: string[] = [];

  if (config.dnsProvider === "manual") {
    manualSteps.push(`Configure DNS: *.${config.domain} → ${config.serverIp || "this server IP"}`);
    manualSteps.push("Configure TLS certificates in Caddyfile");
  } else if (!config.apiToken) {
    const provider = DNS_PROVIDERS.find(p => p.value === config.dnsProvider);
    manualSteps.push(`Set ${provider?.envVar} in ${join(config.installDir, ".env")}`);
    manualSteps.push(`Configure DNS: *.${config.domain} → ${config.serverIp || "this server IP"}`);
    manualSteps.push("Restart services: sudo systemctl restart caddy fast-ngrok");
  }

  if (manualSteps.length > 0) {
    term.yellow("\nManual steps remaining:\n");
    manualSteps.forEach((s, i) => {
      term.gray(`  ${i + 1}. `);
      term.white(`${s}\n`);
    });
  }

  // Show generated API key
  const envContent = await Bun.file(join(config.installDir, ".env")).text();
  const apiKeyMatch = envContent.match(/API_KEY=(\S+)/);
  if (apiKeyMatch) {
    term.white("\nAPI Key (save this for client configuration):\n");
    term.bold.yellow(`  ${apiKeyMatch[1]}\n`);
  }

  term.white("\nUseful commands:\n");
  term.cyan("  journalctl -u fast-ngrok -f    # View logs\n");
  term.cyan("  systemctl status fast-ngrok    # Check status\n");
  term.cyan("  systemctl restart fast-ngrok   # Restart\n");

  term("\n");
  process.exit(0);
}

async function collectConfig(): Promise<InitConfig> {
  // Install directory
  term.white(`Install directory [${DEFAULT_INSTALL_DIR}]: `);
  const installDir = await inputField(DEFAULT_INSTALL_DIR);
  term("\n");

  // Try to load existing .env for pre-filling
  const existingEnv = await loadExistingEnv(installDir);
  if (existingEnv) {
    term.gray("  (Found existing .env, using values as defaults)\n\n");
  }

  // Domain
  term.white("Base domain for tunnels: ");
  const domain = await inputField(existingEnv?.BASE_DOMAIN || "tunnel.example.com");
  term("\n");
  term.gray(`  Tunnels will be: *.${domain}\n`);
  term.gray(`  Example: brave-fox-a1b2.${domain}\n`);

  // Port
  const defaultPort = existingEnv?.TUNNEL_PORT || "3100";
  term.white(`Server port [${defaultPort}]: `);
  const portStr = await inputField(defaultPort);
  const port = parseInt(portStr, 10) || 3100;
  term("\n");

  // Get server IP
  let serverIp: string | undefined;
  try {
    const result = await Bun.$`curl -s ifconfig.me`.text();
    serverIp = result.trim();
    if (serverIp) {
      term.gray(`  Detected server IP: ${serverIp}\n`);
    }
  } catch {
    // Ignore
  }

  // DNS Provider
  term.white("\nSelect DNS provider for wildcard SSL:\n");
  term.gray(`(Required for automatic HTTPS on *.${domain})\n\n`);

  // Find default provider index based on existing .env
  let defaultProviderIndex = 0;
  if (existingEnv) {
    const existingProviderIndex = DNS_PROVIDERS.findIndex(p =>
      p.envVar && existingEnv[p.envVar]
    );
    if (existingProviderIndex !== -1) {
      defaultProviderIndex = existingProviderIndex;
    }
  }

  const dnsProviderIndex = await selectMenu(
    DNS_PROVIDERS.map(p => p.name),
    defaultProviderIndex
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
    const existingToken = selectedProvider.envVar ? existingEnv?.[selectedProvider.envVar] : undefined;
    term.white(`\nEnter ${selectedProvider.envVar}: `);
    apiToken = await inputField(existingToken || "");
    term("\n");

    if (!apiToken) {
      term.yellow("  No token provided - DNS record and SSL will need manual setup\n");
    }
  }

  return {
    domain,
    port,
    dnsProvider: selectedProvider.value,
    apiToken: apiToken || undefined,
    installDir,
    serverIp,
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
  } catch {
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
  await Bun.$`chmod 600 ${envPath}`.quiet();
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

async function setupCaddy(config: InitConfig): Promise<void> {
  const provider = DNS_PROVIDERS.find(p => p.value === config.dnsProvider);
  if (!provider?.caddyModule) return;

  // Check if Caddy is installed
  let caddyInstalled = false;
  try {
    const result = await Bun.$`which caddy`.quiet();
    caddyInstalled = result.exitCode === 0;
  } catch {
    caddyInstalled = false;
  }

  if (!caddyInstalled) {
    term.gray("  Caddy not found, installing...\n");
    await installCaddyWithPlugin(config.dnsProvider);
    return;
  }

  // Check if DNS plugin is installed
  let hasPlugin = false;
  try {
    const result = await Bun.$`caddy list-modules`.text();
    hasPlugin = result.includes(provider.caddyModule);
  } catch {
    hasPlugin = false;
  }

  if (hasPlugin) {
    term.green(`  ✓ Caddy already has ${config.dnsProvider} plugin\n`);
  } else {
    term.yellow(`  Caddy missing ${config.dnsProvider} plugin, rebuilding...\n`);
    await installCaddyWithPlugin(config.dnsProvider);
  }

  // Create symlink for Caddyfile
  const caddyPath = join(config.installDir, "Caddyfile");
  try {
    await Bun.$`ln -sf ${caddyPath} /etc/caddy/Caddyfile`.quiet();
    term.green(`  ✓ Linked Caddyfile to /etc/caddy/Caddyfile\n`);
  } catch {
    term.yellow(`  ⚠ Could not link Caddyfile\n`);
  }

  // Copy env file for Caddy to read
  const envPath = join(config.installDir, ".env");
  try {
    await Bun.$`ln -sf ${envPath} /etc/caddy/.env`.quiet();
  } catch {
    // Ignore
  }
}

async function installCaddyWithPlugin(dnsProvider: string): Promise<void> {
  // First ensure Go is installed (required for xcaddy build)
  let hasGo = false;
  try {
    const goResult = await Bun.$`which go`.quiet();
    hasGo = goResult.exitCode === 0;
  } catch {
    hasGo = false;
  }

  if (!hasGo) {
    term.gray("  Installing Go via apt...\n");
    try {
      await Bun.$`apt-get update 2>&1`.text();
      term.gray(`  apt update done\n`);

      const installResult = await Bun.$`apt-get install -y golang-go 2>&1`.text();
      term.gray(`  apt install done\n`);

      // Verify Go was actually installed
      const goCheck = await Bun.$`/usr/bin/go version 2>&1`.nothrow().text();
      if (goCheck.includes("go version")) {
        term.green(`  ✓ Installed Go: ${goCheck.trim()}\n`);
        hasGo = true;
      } else {
        term.yellow(`  ⚠ Go installed but not working: ${goCheck}\n`);
        term.gray(`  Install output: ${installResult.slice(-300)}\n`);
      }
    } catch (e: unknown) {
      term.yellow("  ⚠ Could not install Go via apt\n");
      if (e && typeof e === "object" && "stderr" in e) {
        const stderr = (e as { stderr: Buffer }).stderr.toString();
        if (stderr) term.gray(`  stderr: ${stderr.slice(0, 300)}\n`);
      }
      if (e && typeof e === "object" && "stdout" in e) {
        const stdout = (e as { stdout: Buffer }).stdout.toString();
        if (stdout) term.gray(`  stdout: ${stdout.slice(-300)}\n`);
      }
    }
  } else {
    const goVer = await Bun.$`go version 2>&1`.nothrow().text();
    term.green(`  ✓ Go already installed: ${goVer.trim()}\n`);
  }

  if (!hasGo) {
    term.red("  ✗ Go is required to build Caddy with plugins\n");
    term.white("  Install manually: apt install golang-go\n");
    return;
  }

  // Check if xcaddy is available
  let hasXcaddy = false;
  try {
    const result = await Bun.$`which xcaddy`.quiet();
    hasXcaddy = result.exitCode === 0;
  } catch {
    hasXcaddy = false;
  }

  if (!hasXcaddy) {
    term.gray("  Installing xcaddy...\n");

    // Try to install xcaddy via Go
    try {
      const home = process.env.HOME || "/root";
      process.env.GOPATH = `${home}/go`;
      process.env.PATH = `${process.env.PATH}:${home}/go/bin`;

      await Bun.$`go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest`.quiet();
      term.green("  ✓ Installed xcaddy via Go\n");
      hasXcaddy = true;
    } catch (e: unknown) {
      term.yellow("  ⚠ Could not install xcaddy via Go\n");
      if (e && typeof e === "object" && "stderr" in e) {
        const stderr = (e as { stderr: Buffer }).stderr.toString();
        if (stderr) term.gray(`  ${stderr.slice(0, 200)}\n`);
      }
    }

    // Fallback: try apt for xcaddy directly
    if (!hasXcaddy) {
      try {
        await Bun.$`apt-get install -y xcaddy 2>&1`.text();
        term.green("  ✓ Installed xcaddy via apt\n");
        hasXcaddy = true;
      } catch {
        // Ignore
      }
    }
  } else {
    term.green("  ✓ xcaddy already installed\n");
  }

  if (!hasXcaddy) {
    term.red("  ✗ Could not install xcaddy. Please install manually:\n");
    term.cyan("    go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest\n");
    term.white("  Then run this command again.\n");
    return;
  }

  // Build Caddy with DNS plugin
  term.gray(`  Building Caddy with ${dnsProvider} plugin (this may take a minute)...\n`);
  try {
    const xcaddyPath = await findCommand("xcaddy");
    await Bun.$`${xcaddyPath} build --with github.com/caddy-dns/${dnsProvider} --output /usr/bin/caddy 2>&1`.text();
    term.green(`  ✓ Built Caddy with ${dnsProvider} plugin\n`);

    // Setup Caddy systemd service if not exists
    try {
      await Bun.$`which systemctl`.quiet();
      const serviceExists = await Bun.file("/etc/systemd/system/caddy.service").exists();
      if (!serviceExists) {
        await setupCaddySystemd();
      }
    } catch {
      // Ignore
    }
  } catch (error: unknown) {
    term.red(`  ✗ Failed to build Caddy\n`);
    if (error && typeof error === "object" && "stderr" in error) {
      const stderr = (error as { stderr: Buffer }).stderr.toString();
      if (stderr) {
        term.gray(`  Error: ${stderr.slice(0, 500)}\n`);
      }
    }
    if (error && typeof error === "object" && "stdout" in error) {
      const stdout = (error as { stdout: Buffer }).stdout.toString();
      if (stdout) {
        term.gray(`  Output: ${stdout.slice(0, 500)}\n`);
      }
    }
  }
}

async function setupCaddySystemd(): Promise<void> {
  const caddyService = `[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=root
Group=root
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
LimitNPROC=512
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
`;

  try {
    await Bun.$`mkdir -p /etc/caddy`.quiet();
    await Bun.write("/etc/systemd/system/caddy.service", caddyService);
    await Bun.$`systemctl daemon-reload`.quiet();
    await Bun.$`systemctl enable caddy`.quiet();
    term.green("  ✓ Created Caddy systemd service\n");
  } catch {
    term.yellow("  ⚠ Could not create Caddy systemd service\n");
  }
}

async function createDnsRecord(config: InitConfig): Promise<void> {
  if (!config.apiToken || !config.serverIp) {
    term.yellow("  ⚠ Skipping DNS setup (missing token or server IP)\n");
    return;
  }

  if (config.dnsProvider === "cloudflare") {
    await createCloudflareDnsRecord(config);
  } else {
    term.gray(`  Auto DNS setup not implemented for ${config.dnsProvider}\n`);
    term.gray(`  Please manually create: *.${config.domain} → ${config.serverIp}\n`);
  }
}

async function createCloudflareDnsRecord(config: InitConfig): Promise<void> {
  if (!config.apiToken || !config.serverIp) return;

  try {
    // Extract base domain (e.g., example.com from tunnel.example.com)
    const domainParts = config.domain.split(".");
    const baseDomain = domainParts.slice(-2).join(".");

    // Get zone ID
    term.gray(`  Finding Cloudflare zone for ${baseDomain}...\n`);
    const zonesResponse = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${baseDomain}`,
      {
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    const zonesData = await zonesResponse.json() as { success: boolean; result: Array<{ id: string }> };

    if (!zonesData.success || !zonesData.result?.[0]?.id) {
      term.yellow("  ⚠ Could not find Cloudflare zone\n");
      return;
    }

    const zoneId = zonesData.result[0].id;

    // Check if wildcard record already exists
    const recordName = `*.${config.domain}`;
    const existingResponse = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?name=${recordName}`,
      {
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    const existingData = await existingResponse.json() as { success: boolean; result: Array<{ id: string }> };

    const existingRecord = existingData.result?.[0];
    if (existingRecord) {
      // Update existing record
      const recordId = existingRecord.id;
      await fetch(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "A",
            name: recordName,
            content: config.serverIp,
            proxied: false,
            ttl: 1, // Auto
          }),
        }
      );
      term.green(`  ✓ Updated DNS record: ${recordName} → ${config.serverIp}\n`);
    } else {
      // Create new record
      await fetch(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "A",
            name: recordName,
            content: config.serverIp,
            proxied: false,
            ttl: 1, // Auto
          }),
        }
      );
      term.green(`  ✓ Created DNS record: ${recordName} → ${config.serverIp}\n`);
    }

    // Also create record for base domain (without wildcard)
    const baseRecordResponse = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?name=${config.domain}`,
      {
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    const baseRecordData = await baseRecordResponse.json() as { success: boolean; result: Array<{ id: string }> };

    const existingBaseRecord = baseRecordData.result?.[0];
    if (existingBaseRecord) {
      const recordId = existingBaseRecord.id;
      await fetch(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "A",
            name: config.domain,
            content: config.serverIp,
            proxied: false,
            ttl: 1,
          }),
        }
      );
    } else {
      await fetch(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "A",
            name: config.domain,
            content: config.serverIp,
            proxied: false,
            ttl: 1,
          }),
        }
      );
    }
    term.green(`  ✓ Created DNS record: ${config.domain} → ${config.serverIp}\n`);
  } catch (error) {
    term.yellow(`  ⚠ Could not create DNS record: ${error}\n`);
    term.gray(`  Please manually create: *.${config.domain} → ${config.serverIp}\n`);
  }
}

async function setupSystemdService(config: InitConfig): Promise<void> {
  // Find the actual path to fast-ngrok
  let execCommand: string;
  try {
    const globalBinPath = await Bun.$`which fast-ngrok`.text();
    execCommand = globalBinPath.trim();
  } catch {
    // Fallback
    const useBun = await hasBun();
    execCommand = useBun ? "/usr/local/bin/fast-ngrok" : "/usr/bin/fast-ngrok";
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
ExecStart=${execCommand} server
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

  const servicePath = "/etc/systemd/system/fast-ngrok.service";

  try {
    await Bun.write(servicePath, serviceContent);
    term.green(`  ✓ Created ${servicePath}\n`);

    await Bun.$`systemctl daemon-reload`.quiet();
    term.green("  ✓ Reloaded systemd\n");

    await Bun.$`systemctl enable fast-ngrok`.quiet();
    term.green("  ✓ Enabled fast-ngrok service\n");
  } catch (error) {
    term.red(`  ✗ Systemd setup failed: ${error}\n`);
  }
}

async function startServices(config: InitConfig): Promise<void> {
  // Start Caddy if not manual
  if (config.dnsProvider !== "manual") {
    try {
      await Bun.$`systemctl restart caddy`.quiet();
      term.green("  ✓ Started Caddy\n");
    } catch {
      term.yellow("  ⚠ Could not start Caddy\n");
    }
  }

  // Start fast-ngrok
  try {
    await Bun.$`systemctl start fast-ngrok`.quiet();
    term.green("  ✓ Started fast-ngrok\n");
  } catch {
    term.yellow("  ⚠ Could not start fast-ngrok\n");
  }

  // Show logs for a few seconds
  term.white("\n  Recent logs:\n");
  term.gray("  ─────────────────────────────────\n");

  try {
    // Give services time to start
    await Bun.sleep(1000);

    // Show recent logs
    const logs = await Bun.$`journalctl -u fast-ngrok -u caddy --no-pager -n 10 --since "10 seconds ago" 2>/dev/null || true`.text();
    if (logs.trim()) {
      for (const line of logs.trim().split("\n").slice(0, 10)) {
        term.gray(`  ${line}\n`);
      }
    } else {
      term.gray("  (no logs yet)\n");
    }
  } catch {
    term.gray("  (could not read logs)\n");
  }

  term.gray("  ─────────────────────────────────\n");
}

async function findCommand(cmd: string): Promise<string> {
  try {
    const result = await Bun.$`which ${cmd}`.text();
    return result.trim();
  } catch {
    return cmd;
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
