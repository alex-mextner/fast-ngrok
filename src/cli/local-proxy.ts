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
    // Keep accept-encoding - let local app decide on compression
    // This preserves ETag behavior (Vary: Accept-Encoding)

    try {
      console.log(`[DEBUG] ${method} ${localUrl}`);
      console.log(`[DEBUG] headers:`, JSON.stringify(forwardHeaders, null, 2));
      console.log(`[DEBUG] body:`, body ? `"${body.slice(0, 200)}"` : "undefined");

      const response = await fetch(localUrl, {
        method,
        headers: forwardHeaders,
        body: method !== "GET" && method !== "HEAD" && body ? body : undefined,
        redirect: "manual", // Don't follow redirects, proxy them as-is
      });

      console.log(`[DEBUG] response: ${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      // Local server not available
      throw new Error(`Local server not responding at localhost:${this.port}`);
    }
  }
}
