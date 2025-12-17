// Persistent subdomain cache: apiKey:port → subdomain
// Ensures same client+port always gets same subdomain

import { join } from "path";

const CACHE_FILE = join(import.meta.dir, "../../.subdomain-cache.json");

interface CacheData {
  // key: "apiKeyHash:port", value: subdomain
  mappings: Record<string, string>;
}

class SubdomainCache {
  private data: CacheData = { mappings: {} };
  private dirty = false;
  private saveTimeout: Timer | null = null;

  async load(): Promise<void> {
    try {
      const file = Bun.file(CACHE_FILE);
      if (await file.exists()) {
        this.data = await file.json();
        console.log(`[cache] Loaded ${Object.keys(this.data.mappings).length} subdomain mappings`);
      }
    } catch (e) {
      console.error("[cache] Failed to load cache:", e);
      this.data = { mappings: {} };
    }
  }

  private async save(): Promise<void> {
    if (!this.dirty) return;
    try {
      await Bun.write(CACHE_FILE, JSON.stringify(this.data, null, 2));
      this.dirty = false;
    } catch (e) {
      console.error("[cache] Failed to save cache:", e);
    }
  }

  private makeKey(apiKey: string, port: number): string {
    // Hash apiKey for privacy (first 8 chars of sha256)
    const hash = new Bun.CryptoHasher("sha256").update(apiKey).digest("hex").slice(0, 8);
    return `${hash}:${port}`;
  }

  get(apiKey: string, port: number): string | undefined {
    const key = this.makeKey(apiKey, port);
    return this.data.mappings[key];
  }

  set(apiKey: string, port: number, subdomain: string): void {
    const key = this.makeKey(apiKey, port);
    if (this.data.mappings[key] !== subdomain) {
      this.data.mappings[key] = subdomain;
      this.dirty = true;
      this.scheduleSave(); // debounced
    }
  }

  private scheduleSave(): void {
    if (this.saveTimeout) return; // already scheduled
    this.saveTimeout = setTimeout(async () => {
      this.saveTimeout = null;
      await this.save();
    }, 1000); // 1s debounce
  }

  async forceSave(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    await this.save();
  }

  // Find if subdomain is already reserved by different apiKey:port
  isReservedByOther(apiKey: string, port: number, subdomain: string): boolean {
    const myKey = this.makeKey(apiKey, port);
    for (const [key, value] of Object.entries(this.data.mappings)) {
      if (value === subdomain && key !== myKey) {
        return true;
      }
    }
    return false;
  }
}

export const subdomainCache = new SubdomainCache();
