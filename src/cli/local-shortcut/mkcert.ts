/**
 * mkcert management for local HTTPS
 * Handles installation and certificate generation
 */

import { homedir } from "os";
import { join } from "path";

const CERTS_DIR = join(homedir(), ".fast-ngrok", "certs");

export interface CertPaths {
  cert: string;
  key: string;
}

/**
 * Check if mkcert is installed
 */
export async function isMkcertInstalled(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", "mkcert"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * Check if Homebrew is installed
 */
async function isBrewInstalled(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", "brew"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * Install mkcert via Homebrew
 */
export async function installMkcert(): Promise<void> {
  if (!(await isBrewInstalled())) {
    throw new Error(
      "Homebrew is not installed. Please install it first: https://brew.sh"
    );
  }

  console.log("📦 Installing mkcert via Homebrew...");

  const proc = Bun.spawn(["brew", "install", "mkcert"], {
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error("Failed to install mkcert");
  }

  console.log("✅ mkcert installed");
}

/**
 * Check if mkcert CA is installed in system trust store
 */
export async function isCaInstalled(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["mkcert", "-CAROOT"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) return false;

    const caRoot = (await new Response(proc.stdout).text()).trim();
    const rootCA = Bun.file(join(caRoot, "rootCA.pem"));

    return await rootCA.exists();
  } catch {
    return false;
  }
}

/**
 * Install mkcert CA to system trust store
 * Will prompt for sudo password
 */
export async function installCa(): Promise<void> {
  console.log("🔐 Installing mkcert CA to system trust store...");
  console.log("   (This requires administrator privileges)");

  const proc = Bun.spawn(["mkcert", "-install"], {
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error("Failed to install mkcert CA");
  }

  console.log("✅ CA installed");
}

/**
 * Get cert paths for a domain
 */
export function getCertPaths(baseDomain: string): CertPaths {
  const domainDir = join(CERTS_DIR, baseDomain);
  return {
    cert: join(domainDir, "cert.pem"),
    key: join(domainDir, "key.pem"),
  };
}

/**
 * Check if certificates exist for domain
 */
export async function certsExist(baseDomain: string): Promise<boolean> {
  const paths = getCertPaths(baseDomain);
  const certFile = Bun.file(paths.cert);
  const keyFile = Bun.file(paths.key);

  return (await certFile.exists()) && (await keyFile.exists());
}

/**
 * Generate wildcard certificate for domain
 */
export async function generateCerts(baseDomain: string): Promise<CertPaths> {
  const paths = getCertPaths(baseDomain);
  const domainDir = join(CERTS_DIR, baseDomain);

  // Ensure directory exists
  await Bun.$`mkdir -p ${domainDir}`;

  console.log(`🔑 Generating certificate for *.${baseDomain}...`);

  const proc = Bun.spawn(
    [
      "mkcert",
      "-cert-file",
      paths.cert,
      "-key-file",
      paths.key,
      `*.${baseDomain}`,
      baseDomain,
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
    }
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error("Failed to generate certificates");
  }

  console.log("✅ Certificates generated");
  return paths;
}

/**
 * Ensure mkcert is ready (installed, CA installed)
 * Returns cert paths for the given domain
 */
export async function ensureMkcertReady(baseDomain: string): Promise<CertPaths> {
  // 1. Check/install mkcert
  if (!(await isMkcertInstalled())) {
    await installMkcert();
  }

  // 2. Check/install CA
  if (!(await isCaInstalled())) {
    await installCa();
  }

  // 3. Check/generate certs
  if (!(await certsExist(baseDomain))) {
    return await generateCerts(baseDomain);
  }

  return getCertPaths(baseDomain);
}

/**
 * Extract base domain from full hostname
 * e.g., "brave-fox-a1b2.tunnel.example.com" -> "tunnel.example.com"
 */
export function extractBaseDomain(hostname: string): string {
  const parts = hostname.split(".");
  if (parts.length < 3) {
    return hostname; // Already base domain
  }
  return parts.slice(1).join(".");
}
