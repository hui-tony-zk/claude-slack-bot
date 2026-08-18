import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { MAX_LOG_BYTES, PATHS } from "./config.js";
import type { LogLevel, LogPayload } from "./types.js";

const MAX_LOGGED_ERROR_OUTPUT_CHARS = 20_000;
const SECRET_PATTERNS = [
  /\b(?:xox[baprs]-|xapp-)[A-Za-z0-9-]+\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi,
];

function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
}

function boundedErrorOutput(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const redacted = redactSecrets(value);
  if (redacted.length <= MAX_LOGGED_ERROR_OUTPUT_CHARS) return redacted;
  return `${redacted.slice(0, MAX_LOGGED_ERROR_OUTPUT_CHARS)}\n...[truncated ${redacted.length - MAX_LOGGED_ERROR_OUTPUT_CHARS} chars]`;
}

export function serializeError(error: unknown, depth = 0): Record<string, unknown> {
  if (depth > 3) return { value: "[cause depth exceeded]" };
  if (!(error instanceof Error)) return { value: redactSecrets(String(error)) };

  const source = error as Error & Record<string, unknown>;
  const serialized: Record<string, unknown> = {
    name: error.name,
    message: redactSecrets(error.message),
    stack: error.stack ? redactSecrets(error.stack) : undefined,
  };

  for (const key of ["code", "errno", "syscall", "signal", "status", "exitCode"]) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      serialized[key] = value;
    }
  }

  for (const key of ["stderr", "stdout"] as const) {
    const value = boundedErrorOutput(source[key]);
    if (value) serialized[key] = value;
  }

  if (error.cause !== undefined) serialized.cause = serializeError(error.cause, depth + 1);
  return serialized;
}

function writeStderrLine(line: string): void {
  try {
    process.stderr.write(line + "\n");
  } catch {}
}

function rotateLogsIfNeeded(): void {
  try {
    if (!existsSync(PATHS.LOG_FILE)) return;
    if (statSync(PATHS.LOG_FILE).size < MAX_LOG_BYTES) return;
    try {
      unlinkSync(PATHS.LOG_ROTATED_FILE);
    } catch {}
    renameSync(PATHS.LOG_FILE, PATHS.LOG_ROTATED_FILE);
  } catch (err) {
    writeStderrLine(`[logger] failed to rotate logs: ${(err as Error).message}`);
  }
}

export function writeLog(level: LogLevel, { scope = "app", threadTs = null, message, ...extra }: LogPayload): void {
  const entry = {
    ts: new Date().toISOString(),
    pid: process.pid,
    level,
    scope,
    threadTs,
    message,
    ...extra,
  };
  const line = JSON.stringify(entry);
  if (level === "error") writeStderrLine(line);
  try {
    rotateLogsIfNeeded();
    appendFileSync(PATHS.LOG_FILE, line + "\n");
  } catch (err) {
    writeStderrLine(line);
    writeStderrLine(`[logger] failed to write log entry: ${(err as Error).message}`);
  }
}

export function logThread(threadTs: string, message: string, extra: Record<string, unknown> = {}): void {
  writeLog("info", { scope: "thread", threadTs, message, ...extra });
}

export function removeLegacyRuntimeLog(): void {
  try {
    unlinkSync(PATHS.RUNTIME_LOG_FILE);
  } catch {}
}
