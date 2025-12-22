/**
 * Error logger for fast-ngrok CLI
 * Writes errors to a log file instead of console to keep TUI clean
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface Logger {
  error: (message: string, error?: unknown) => void;
  warn: (message: string) => void;
  hasErrors: () => boolean;
  getLogPath: () => string;
  clear: () => void;
}

let logPath: string | null = null;
let errorCount = 0;

function getLogDir(): string {
  return join(homedir(), ".fast-ngrok");
}

function getDefaultLogPath(): string {
  return join(getLogDir(), "error.log");
}

function ensureLogDir(): void {
  const dir = getLogDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

export function createLogger(customPath?: string): Logger {
  logPath = customPath ?? getDefaultLogPath();
  errorCount = 0;

  ensureLogDir();

  // Clear previous log on start
  writeFileSync(logPath, `=== fast-ngrok started at ${formatTimestamp()} ===\n`);

  return {
    error: (message: string, error?: unknown) => {
      if (!logPath) return;

      errorCount++;
      let entry = `[${formatTimestamp()}] ERROR: ${message}`;
      if (error) {
        entry += `\n${formatError(error)}`;
      }
      entry += "\n\n";

      try {
        appendFileSync(logPath, entry);
      } catch {
        // Can't log the logging error, ignore
      }
    },

    warn: (message: string) => {
      if (!logPath) return;

      const entry = `[${formatTimestamp()}] WARN: ${message}\n`;
      try {
        appendFileSync(logPath, entry);
      } catch {
        // Ignore
      }
    },

    hasErrors: () => errorCount > 0,

    getLogPath: () => logPath ?? getDefaultLogPath(),

    clear: () => {
      errorCount = 0;
      if (logPath) {
        writeFileSync(logPath, `=== Log cleared at ${formatTimestamp()} ===\n`);
      }
    },
  };
}

// Global logger instance (initialized in http command)
let globalLogger: Logger | null = null;

export function initLogger(customPath?: string): Logger {
  globalLogger = createLogger(customPath);
  return globalLogger;
}

export function getLogger(): Logger | null {
  return globalLogger;
}
