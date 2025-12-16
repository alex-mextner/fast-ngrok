import { join } from "path";

export async function initCommand(): Promise<void> {
  console.log("Fast-ngrok Server Initialization\n");

  // Generate a secure random API key
  const apiKey = generateApiKey();

  // Check if .env exists
  const envPath = join(process.cwd(), ".env");
  const envFile = Bun.file(envPath);
  const envExists = await envFile.exists();

  let envContent = "";

  if (envExists) {
    envContent = await envFile.text();

    // Check if API_KEY already exists
    if (envContent.includes("API_KEY=")) {
      console.log("API_KEY already exists in .env");
      console.log("If you want to regenerate, remove the existing API_KEY first.\n");
      process.exit(1);
    }

    envContent += "\n";
  }

  // Add configuration
  envContent += `# Fast-ngrok configuration (generated)\n`;
  envContent += `API_KEY=${apiKey}\n`;

  if (!envContent.includes("BASE_DOMAIN=")) {
    envContent += `BASE_DOMAIN=tunnel.example.com\n`;
  }
  if (!envContent.includes("TUNNEL_PORT=")) {
    envContent += `TUNNEL_PORT=3100\n`;
  }
  if (!envContent.includes("CADDY_ADMIN_URL=")) {
    envContent += `CADDY_ADMIN_URL=http://localhost:2019\n`;
  }

  await Bun.write(envPath, envContent);

  console.log("Generated API Key:");
  console.log(`  ${apiKey}\n`);
  console.log(`Configuration ${envExists ? "updated" : "created"} in .env`);
  console.log("\nNext steps:");
  console.log("  1. Update BASE_DOMAIN in .env to your actual domain");
  console.log("  2. Configure Caddy with wildcard SSL for *.your-domain.com");
  console.log("  3. Start the server: bun run server");
  console.log("  4. On client: bunx fast-ngrok auth");
}

function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
