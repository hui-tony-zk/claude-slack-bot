import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { MAX_LOG_BYTES, PATHS } from "./config.js";
import type { LogLevel, LogPayload } from "./types.js";

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
