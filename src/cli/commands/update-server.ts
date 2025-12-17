import { join } from "node:path";

const DEFAULT_INSTALL_DIR = "/opt/fast-ngrok";

interface EnvConfig {
  baseDomain?: string;
  tunnelPort?: string;
  dnsProvider?: string;
  dnsEnvVar?: string;
}

const DNS_PROVIDERS = [
  { envVar: "CF_API_TOKEN", provider: "cloudflare" },
  { envVar: "DO_AUTH_TOKEN", provider: "digitalocean" },
  { envVar: "HETZNER_API_KEY", provider: "hetzner" },
  { envVar: "VULTR_API_KEY", provider: "vultr" },
  { envVar: "AWS_ACCESS_KEY_ID", provider: "route53" },
];

async function getBunGlobalBinDir(): Promise<string | null> {
  try {
    // Most reliable way - ask bun directly
    const result = await Bun.$`bun pm bin -g`.text();
    return result.trim();
  } catch {
    return null;
  }
}

async function loadEnvConfig(envPath: string): Promise<EnvConfig> {
  const config: EnvConfig = {};
  try {
    const content = await Bun.file(envPath).text();
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();

      if (key === "BASE_DOMAIN") config.baseDomain = value;
      if (key === "TUNNEL_PORT") config.tunnelPort = value;

      // Detect DNS provider from env vars
      const provider = DNS_PROVIDERS.find((p) => p.envVar === key);
      if (provider && value) {
        config.dnsProvider = provider.provider;
        config.dnsEnvVar = provider.envVar;
      }
    }
  } catch {
    // ignore
  }
  return config;
}

export async function updateServerCommand(): Promise<void> {
  // Check if running as root
  const isRoot = process.getuid?.() === 0;
  if (!isRoot) {
    console.error("Error: This command requires root permissions.");
    console.log("Run with: sudo fast-ngrok update-server");
    process.exit(1);
  }

  console.log("Updating fast-ngrok server...\n");

  // Get bun's global bin directory
  const bunBinDir = await getBunGlobalBinDir();
  if (bunBinDir) {
    console.log(`Bun global bin: ${bunBinDir}`);
  }

  // Find the actual path to fast-ngrok binary
  let execPath: string | null = null;

  // First try bun's global bin
  if (bunBinDir) {
    const bunPath = `${bunBinDir}/fast-ngrok`;
    if (await Bun.file(bunPath).exists()) {
      execPath = bunPath;
    }
  }

  // Then try which
  if (!execPath) {
    try {
      const result = await Bun.$`which fast-ngrok`.text();
      execPath = result.trim();
    } catch {
      // ignore
    }
  }

  // Fallback paths
  if (!execPath) {
    const fallbackPaths = [
      "/usr/local/bin/fast-ngrok",
      "/usr/bin/fast-ngrok",
    ];

    for (const p of fallbackPaths) {
      if (await Bun.file(p).exists()) {
        execPath = p;
        break;
      }
    }
  }

  if (!execPath) {
    console.error("Error: Could not find fast-ngrok binary");
    console.log("Install it globally: bun add -g fast-ngrok");
    process.exit(1);
  }

  console.log(`Found fast-ngrok at: ${execPath}`);

  // Check install dir
  let installDir = DEFAULT_INSTALL_DIR;
  const envPath = `${DEFAULT_INSTALL_DIR}/.env`;
  const envExists = await Bun.file(envPath).exists();

  if (!envExists) {
    console.warn(`Warning: ${envPath} not found`);
    console.log("Using /root as working directory\n");
    installDir = "/root";
  }

  // Build PATH with bun's bin dir if available
  const pathParts = [bunBinDir, "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean);
  const envPath2 = pathParts.join(":");

  const serviceContent = `[Unit]
Description=Fast-ngrok Tunnel Server
After=network.target caddy.service
Wants=caddy.service

[Service]
Type=simple
User=root
WorkingDirectory=${installDir}
Environment=PATH=${envPath2}
${envExists ? `EnvironmentFile=${envPath}` : "# No .env file found"}
ExecStart=${execPath} server
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

  const servicePath = "/etc/systemd/system/fast-ngrok.service";

  try {
    await Bun.write(servicePath, serviceContent);
    console.log(`✓ Updated ${servicePath}`);

    await Bun.$`systemctl daemon-reload`.quiet();
    console.log("✓ Reloaded systemd");

    await Bun.$`systemctl restart fast-ngrok`.quiet();
    console.log("✓ Restarted fast-ngrok service");

    // Load env config and fix Caddyfile if needed
    const envConfig = await loadEnvConfig(envPath);
    await ensureValidCaddyfile(installDir, envConfig);

    // Update Caddyfile symlink
    await updateCaddyfileSymlink(installDir);

    // Show status
    console.log("\nService status:");
    const status = await Bun.$`systemctl status fast-ngrok --no-pager -l`.nothrow().text();
    console.log(status);
  } catch (error) {
    console.error(`Error: ${error}`);
    process.exit(1);
  }
}

async function ensureValidCaddyfile(installDir: string, envConfig: EnvConfig): Promise<void> {
  const caddyPath = join(installDir, "Caddyfile");

  if (!envConfig.baseDomain) {
    console.log("⚠ BASE_DOMAIN not found in .env, skipping Caddyfile check");
    return;
  }

  const file = Bun.file(caddyPath);
  const exists = await file.exists();
  let needsRegeneration = false;

  if (!exists) {
    console.log("⚠ Caddyfile not found, generating...");
    needsRegeneration = true;
  } else {
    // Check if Caddyfile has correct content (should contain the domain config)
    const content = await file.text();
    const expectedPattern = `*.${envConfig.baseDomain}`;

    if (!content.includes(expectedPattern)) {
      console.log("⚠ Caddyfile appears corrupted (missing domain config), regenerating...");
      needsRegeneration = true;
    }
  }

  if (needsRegeneration) {
    const port = envConfig.tunnelPort || "3100";
    const caddyfile = generateCaddyfile(envConfig.baseDomain, port, envConfig.dnsProvider, envConfig.dnsEnvVar);
    await Bun.write(caddyPath, caddyfile);
    console.log(`✓ Regenerated ${caddyPath}`);

    // Restart Caddy to pick up new config
    try {
      await Bun.$`systemctl restart caddy`.quiet();
      console.log("✓ Restarted Caddy");
    } catch {
      console.log("⚠ Could not restart Caddy");
    }
  } else {
    console.log("✓ Caddyfile is valid");
  }
}

function generateCaddyfile(domain: string, port: string, dnsProvider?: string, dnsEnvVar?: string): string {
  let tlsBlock: string;

  if (!dnsProvider || !dnsEnvVar) {
    tlsBlock = `    # No DNS provider configured - using HTTP challenge
    # For wildcard certs, configure DNS provider in .env`;
  } else if (dnsProvider === "route53") {
    tlsBlock = `    tls {
        dns route53 {
            access_key_id {env.AWS_ACCESS_KEY_ID}
            secret_access_key {env.AWS_SECRET_ACCESS_KEY}
            region {env.AWS_REGION}
        }
    }`;
  } else {
    tlsBlock = `    tls {
        dns ${dnsProvider} {env.${dnsEnvVar}}
    }`;
  }

  return `# Fast-ngrok tunnel server
# Domain: ${domain}

# Main domain for API
${domain} {
${tlsBlock}

    reverse_proxy localhost:${port}
}

# Wildcard for tunnel subdomains
*.${domain} {
${tlsBlock}

    reverse_proxy localhost:${port}
}
`;
}

async function updateCaddyfileSymlink(installDir: string): Promise<void> {
  const caddyPath = join(installDir, "Caddyfile");

  // Check if local Caddyfile exists
  if (!(await Bun.file(caddyPath).exists())) {
    return;
  }

  try {
    await Bun.$`mkdir -p /etc/caddy/Caddyfile.d`.quiet();
    await Bun.$`ln -sf ${caddyPath} /etc/caddy/Caddyfile.d/fast-ngrok`.quiet();
    console.log("✓ Linked Caddyfile to /etc/caddy/Caddyfile.d/fast-ngrok");

    // Add import directive to main Caddyfile if not present
    await ensureCaddyfileImport();
  } catch {
    console.log("⚠ Could not update Caddyfile symlink");
  }
}

async function ensureCaddyfileImport(): Promise<void> {
  const mainCaddyfile = "/etc/caddy/Caddyfile";
  const importLine = "import /etc/caddy/Caddyfile.d/*";

  try {
    const file = Bun.file(mainCaddyfile);
    const exists = await file.exists();

    if (!exists) {
      await Bun.write(mainCaddyfile, `# Caddy configuration\n${importLine}\n`);
      console.log(`✓ Created ${mainCaddyfile} with import directive`);
      return;
    }

    const content = await file.text();

    if (content.includes("import /etc/caddy/Caddyfile.d/")) {
      console.log("✓ Import directive already present in Caddyfile");
      return;
    }

    const newContent = `${content.trimEnd()}\n\n# Added by fast-ngrok\n${importLine}\n`;
    await Bun.write(mainCaddyfile, newContent);
    console.log(`✓ Added import directive to ${mainCaddyfile}`);
  } catch (error) {
    console.log(`⚠ Could not update ${mainCaddyfile}: ${error}`);
    console.log(`  Please add manually: ${importLine}`);
  }
}
