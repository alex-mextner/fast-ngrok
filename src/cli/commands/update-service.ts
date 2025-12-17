const DEFAULT_INSTALL_DIR = "/opt/fast-ngrok";

async function getBunGlobalBinDir(): Promise<string | null> {
  try {
    // Most reliable way - ask bun directly
    const result = await Bun.$`bun pm bin -g`.text();
    return result.trim();
  } catch {
    return null;
  }
}

export async function updateServiceCommand(): Promise<void> {
  // Check if running as root
  const isRoot = process.getuid?.() === 0;
  if (!isRoot) {
    console.error("Error: This command requires root permissions.");
    console.log("Run with: sudo fast-ngrok update-service");
    process.exit(1);
  }

  console.log("Updating fast-ngrok systemd service...\n");

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

    // Show status
    console.log("\nService status:");
    const status = await Bun.$`systemctl status fast-ngrok --no-pager -l`.nothrow().text();
    console.log(status);
  } catch (error) {
    console.error(`Error: ${error}`);
    process.exit(1);
  }
}
