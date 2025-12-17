/**
 * /etc/hosts manipulation for local shortcut
 * Adds/removes entries to redirect tunnel domain to localhost
 */

const HOSTS_FILE = "/etc/hosts";
const MARKER = "# fast-ngrok local-shortcut";

export interface HostsEntry {
  ip: string;
  hostname: string;
}

/**
 * Add entry to /etc/hosts
 * Requires sudo only if entry doesn't exist
 */
export async function addHostsEntry(hostname: string): Promise<boolean> {
  // Check if already exists (no sudo needed for read)
  if (await hasHostsEntry(hostname)) {
    return false; // Already exists, no sudo needed
  }

  const entry = `127.0.0.1 ${hostname} ${MARKER}`;

  // Append using sudo tee
  const proc = Bun.spawn(["sudo", "tee", "-a", HOSTS_FILE], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(`\n${entry}\n`);
  proc.stdin.end();

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to add hosts entry: ${stderr}`);
  }

  return true; // Entry was added
}

/**
 * Remove entry from /etc/hosts
 * Removes only lines with our marker
 */
export async function removeHostsEntry(hostname: string): Promise<void> {
  const currentContent = await Bun.file(HOSTS_FILE).text();

  // Filter out lines containing our hostname AND marker
  const lines = currentContent.split("\n");
  const filteredLines = lines.filter(
    (line) => !(line.includes(hostname) && line.includes(MARKER))
  );

  const newContent = filteredLines.join("\n");

  if (newContent === currentContent) {
    return; // Nothing to remove
  }

  // Write back using sudo tee
  const proc = Bun.spawn(["sudo", "tee", HOSTS_FILE], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(newContent);
  proc.stdin.end();

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to remove hosts entry: ${stderr}`);
  }
}

/**
 * Check if entry exists in hosts
 */
export async function hasHostsEntry(hostname: string): Promise<boolean> {
  try {
    const content = await Bun.file(HOSTS_FILE).text();
    return content.includes(hostname) && content.includes(MARKER);
  } catch {
    return false;
  }
}

/**
 * Remove ALL fast-ngrok entries from /etc/hosts
 */
export async function removeAllHostsEntries(): Promise<boolean> {
  const currentContent = await Bun.file(HOSTS_FILE).text();

  // Filter out all lines with our marker
  const lines = currentContent.split("\n");
  const filteredLines = lines.filter((line) => !line.includes(MARKER));

  const newContent = filteredLines.join("\n");

  if (newContent === currentContent) {
    return false; // Nothing to remove
  }

  // Write back using sudo tee
  const proc = Bun.spawn(["sudo", "tee", HOSTS_FILE], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(newContent);
  proc.stdin.end();

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to remove hosts entries: ${stderr}`);
  }

  return true;
}
