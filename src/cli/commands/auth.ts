import * as readline from "readline/promises";
import { getConfig, saveConfig, getConfigPath } from "../config.ts";

export async function authCommand(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("Fast-ngrok Configuration\n");

  const existing = await getConfig();
  if (existing) {
    console.log(`Current server: ${existing.serverUrl}`);
    console.log("");
  }

  try {
    const serverUrl = await rl.question(
      "Server URL (e.g., https://tunnel.example.com): "
    );

    if (!serverUrl) {
      console.error("Server URL is required");
      process.exit(1);
    }

    const apiKey = await rl.question("API Key: ");

    if (!apiKey) {
      console.error("API Key is required");
      process.exit(1);
    }

    rl.close();

    // Validate connection
    console.log("\nValidating connection...");

    try {
      const response = await fetch(`${serverUrl}/__tunnel__/verify`, {
        headers: { "x-api-key": apiKey },
      });

      if (!response.ok) {
        console.error("Invalid API key or server not responding");
        process.exit(1);
      }
    } catch (error) {
      console.error(
        `Failed to connect: ${error instanceof Error ? error.message : "Unknown error"}`
      );
      process.exit(1);
    }

    await saveConfig({ serverUrl, apiKey });
    console.log(`\nConfiguration saved to ${getConfigPath()}`);
  } catch (error) {
    rl.close();
    throw error;
  }
}
