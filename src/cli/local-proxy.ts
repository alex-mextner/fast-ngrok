// Forward requests to local server

export class LocalProxy {
  constructor(private port: number) {}

  async forward(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string
  ): Promise<Response> {
    const localUrl = `http://localhost:${this.port}${path}`;

    // Remove headers that shouldn't be forwarded
    const forwardHeaders = { ...headers };
    delete forwardHeaders["host"];
    delete forwardHeaders["x-tunnel-subdomain"];
    // Remove body-related headers for requests without body - fetch will set them correctly
    if (!body) {
      delete forwardHeaders["content-length"];
      delete forwardHeaders["transfer-encoding"];
    }
    // Keep accept-encoding - let local app decide on compression
    // This preserves ETag behavior (Vary: Accept-Encoding)

    try {
      return await fetch(localUrl, {
        method,
        headers: forwardHeaders,
        body: method !== "GET" && method !== "HEAD" && body ? body : undefined,
        redirect: "manual", // Don't follow redirects, proxy them as-is
      });
    } catch {
      // Local server not available
      throw new Error(`Local server not responding at localhost:${this.port}`);
    }
  }
}
