// Caddy Admin API client for dynamic route management

export class CaddyApi {
  constructor(
    private adminUrl: string,
    private baseDomain: string,
    private tunnelPort: number
  ) {}

  async addTunnelRoute(subdomain: string): Promise<boolean> {
    const route = {
      "@id": `tunnel-${subdomain}`,
      match: [{ host: [`${subdomain}.${this.baseDomain}`] }],
      handle: [
        {
          handler: "reverse_proxy",
          upstreams: [{ dial: `localhost:${this.tunnelPort}` }],
          headers: {
            request: {
              set: {
                "X-Tunnel-Subdomain": [subdomain],
              },
            },
          },
        },
      ],
      terminal: true,
    };

    try {
      const response = await fetch(
        `${this.adminUrl}/config/apps/http/servers/srv0/routes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(route),
        }
      );

      if (!response.ok) {
        const text = await response.text();
        console.error(`[caddy] Failed to add route: ${text}`);
        return false;
      }

      console.log(`[caddy] Added route for ${subdomain}.${this.baseDomain}`);
      return true;
    } catch (error) {
      console.error(`[caddy] Error adding route:`, error);
      return false;
    }
  }

  async removeTunnelRoute(subdomain: string): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.adminUrl}/id/tunnel-${subdomain}`,
        { method: "DELETE" }
      );

      if (!response.ok && response.status !== 404) {
        const text = await response.text();
        console.error(`[caddy] Failed to remove route: ${text}`);
        return false;
      }

      console.log(`[caddy] Removed route for ${subdomain}.${this.baseDomain}`);
      return true;
    } catch (error) {
      console.error(`[caddy] Error removing route:`, error);
      return false;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.adminUrl}/config/`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
