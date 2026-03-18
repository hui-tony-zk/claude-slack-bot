import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from "@anthropic-ai/claude-agent-sdk";
import type { SDKSession, SDKMessage, SDKSessionOptions } from "@anthropic-ai/claude-agent-sdk";
import { logThread, writeLog } from "./logger.js";

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

type ManagedSession = {
  session: SDKSession;
  sessionId: string;
  lastActivity: number;
};

const liveSessions = new Map<string, ManagedSession>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export type SessionOptionsBase = Omit<SDKSessionOptions, "model"> & {
  model?: string;
};

function getModel(): string {
  return process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
}

function buildSessionOptions(extra?: SessionOptionsBase): SDKSessionOptions {
  const { model, ...rest } = extra || {};
  return {
    model: model || getModel(),
    ...rest,
  };
}

function isSessionAlive(managed: ManagedSession): boolean {
  return Date.now() - managed.lastActivity < SESSION_IDLE_TIMEOUT_MS;
}

/**
 * Get or create a live session for a Slack thread.
 *
 * - If a live session exists and was active within 30 min, reuse it.
 * - If a session exists but is idle > 30 min, close it and resume via
 *   `unstable_v2_resumeSession` to reconnect to the persisted session.
 * - If no session at all but we have a persisted sessionId, resume.
 * - Otherwise create a fresh one via `unstable_v2_createSession`.
 *
 * Returns the session and whether it was freshly created/resumed
 * (needs first stream drain before `.send()` can be used).
 */
export function getOrCreateSession(
  threadTs: string,
  persistedSessionId: string | undefined,
  opts?: SessionOptionsBase
): { session: SDKSession; isNew: boolean } {
  const existing = liveSessions.get(threadTs);

  // Case 1: Live session that's still fresh — reuse directly
  if (existing && isSessionAlive(existing)) {
    existing.lastActivity = Date.now();
    logThread(threadTs, "Reusing live session", { sessionId: existing.sessionId });
    return { session: existing.session, isNew: false };
  }

  // Case 2: Stale live session — close it, then resume
  if (existing) {
    logThread(threadTs, "Closing idle session", {
      sessionId: existing.sessionId,
      idleMs: Date.now() - existing.lastActivity,
    });
    try {
      existing.session.close();
    } catch (err) {
      writeLog("error", {
        scope: "sessions",
        threadTs,
        message: "Error closing idle session",
        error: (err as Error).message,
      });
    }
    liveSessions.delete(threadTs);
  }

  const sessionOpts = buildSessionOptions(opts);

  // Determine the ID to resume from (expired live session or persisted)
  const resumeId = existing?.sessionId || persistedSessionId;

  // Case 3: We have a session ID to resume
  if (resumeId) {
    logThread(threadTs, "Resuming session", { sessionId: resumeId });
    const session = unstable_v2_resumeSession(resumeId, sessionOpts);
    liveSessions.set(threadTs, {
      session,
      sessionId: resumeId,
      lastActivity: Date.now(),
    });
    return { session, isNew: true };
  }

  // Case 4: Brand new session
  logThread(threadTs, "Creating new session");
  const session = unstable_v2_createSession(sessionOpts);
  liveSessions.set(threadTs, {
    session,
    sessionId: "", // populated once init message arrives
    lastActivity: Date.now(),
  });
  return { session, isNew: true };
}

/**
 * Update the cached session ID once we learn it from the init message.
 */
export function setSessionId(threadTs: string, sessionId: string): void {
  const managed = liveSessions.get(threadTs);
  if (managed) {
    managed.sessionId = sessionId;
  }
}

/**
 * Record activity on a thread's session.
 */
export function touchSession(threadTs: string): void {
  const managed = liveSessions.get(threadTs);
  if (managed) {
    managed.lastActivity = Date.now();
  }
}

/**
 * Forcibly close and remove a thread's session (e.g., on /new command).
 */
export function closeSession(threadTs: string): void {
  const managed = liveSessions.get(threadTs);
  if (!managed) return;
  try {
    managed.session.close();
  } catch (err) {
    writeLog("error", {
      scope: "sessions",
      threadTs,
      message: "Error closing session",
      error: (err as Error).message,
    });
  }
  liveSessions.delete(threadTs);
  logThread(threadTs, "Session closed and removed from live pool");
}

/**
 * Get the session ID for a thread, if a live session exists.
 */
export function getLiveSessionId(threadTs: string): string | undefined {
  return liveSessions.get(threadTs)?.sessionId || undefined;
}

/**
 * Close all sessions idle > 30 minutes.
 */
function cleanupIdleSessions(): void {
  const now = Date.now();
  for (const [threadTs, managed] of liveSessions.entries()) {
    if (now - managed.lastActivity >= SESSION_IDLE_TIMEOUT_MS) {
      logThread(threadTs, "Cleanup: closing idle session", {
        sessionId: managed.sessionId,
        idleMs: now - managed.lastActivity,
      });
      try {
        managed.session.close();
      } catch (err) {
        writeLog("error", {
          scope: "sessions",
          threadTs,
          message: "Cleanup: error closing session",
          error: (err as Error).message,
        });
      }
      liveSessions.delete(threadTs);
    }
  }
}

/**
 * Start the background cleanup timer.
 */
export function startSessionCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanupIdleSessions, CLEANUP_INTERVAL_MS);
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    (cleanupTimer as NodeJS.Timeout).unref();
  }
  writeLog("info", {
    scope: "sessions",
    message: "Session cleanup timer started",
    intervalMs: CLEANUP_INTERVAL_MS,
    idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
  });
}

/**
 * Stop the cleanup timer and close all live sessions.
 */
export function shutdownAllSessions(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  for (const [threadTs, managed] of liveSessions.entries()) {
    try {
      managed.session.close();
    } catch {}
    logThread(threadTs, "Shutdown: closed session", { sessionId: managed.sessionId });
  }
  liveSessions.clear();
  writeLog("info", { scope: "sessions", message: "All sessions shut down" });
}

/**
 * Number of live sessions (for diagnostics).
 */
export function liveSessionCount(): number {
  return liveSessions.size;
}
