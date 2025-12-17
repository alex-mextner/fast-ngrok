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
    // Remove accept-encoding - we handle compression ourselves
    // Otherwise fetch auto-decompresses but may leave content-encoding header
    delete forwardHeaders["accept-encoding"];

    try {
      return await fetch(localUrl, {
        method,
        headers: forwardHeaders,
        body: method !== "GET" && method !== "HEAD" ? body : undefined,
      });
    } catch (error) {
      // Local server not available
      throw new Error(`Local server not responding at localhost:${this.port}`);
    }
  }
}
