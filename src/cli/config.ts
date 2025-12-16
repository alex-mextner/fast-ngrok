import { homedir } from "os";
import { join } from "path";
import type { Config } from "../shared/types.ts";

const CONFIG_DIR = join(homedir(), ".fast-ngrok");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export async function getConfig(): Promise<Config | null> {
  try {
    const file = Bun.file(CONFIG_FILE);
    if (!(await file.exists())) return null;
    return (await file.json()) as Config;
  } catch {
    return null;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  // Ensure directory exists
  const dir = Bun.file(CONFIG_DIR);
  try {
    await Bun.$`mkdir -p ${CONFIG_DIR}`;
  } catch {
    // Directory might already exist
  }

  await Bun.write(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
