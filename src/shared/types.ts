// Common types used across server and CLI

export interface TunnelInfo {
  subdomain: string;
  publicUrl: string;
  localPort: number;
  createdAt: number;
}

export interface RequestInfo {
  id: string;
  method: string;
  path: string;
  startTime: number;
  status?: number;
  duration?: number;
  error?: boolean;
}

export interface Config {
  serverUrl: string;
  apiKey: string;
}

export interface ServerConfig {
  apiKey: string;
  baseDomain: string;
  tunnelPort: number;
  caddyAdminUrl: string;
}

export function getServerConfig(): ServerConfig {
  const apiKey = process.env.API_KEY;
  const baseDomain = process.env.BASE_DOMAIN;
  const tunnelPort = parseInt(process.env.TUNNEL_PORT || "3100", 10);
  const caddyAdminUrl = process.env.CADDY_ADMIN_URL || "http://localhost:2019";

  if (!apiKey) {
    throw new Error("API_KEY not set in environment");
  }
  if (!baseDomain) {
    throw new Error("BASE_DOMAIN not set in environment");
  }

  return { apiKey, baseDomain, tunnelPort, caddyAdminUrl };
}
