import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { PATHS } from "./config.js";
import { writeLog } from "./logger.js";
import type { ActiveQuery } from "./types.js";

type PersistedSessions = { sessions: Record<string, string>; cwds: Record<string, string> };
type PersistedActive = { active: Record<string, ActiveQuery>; interrupted: Record<string, ActiveQuery> };

function loadSessions(): PersistedSessions {
  if (!existsSync(PATHS.STATE_FILE)) return { sessions: {}, cwds: {} };
  try {
    return JSON.parse(readFileSync(PATHS.STATE_FILE, "utf-8"));
  } catch (err) {
    writeLog("error", {
      scope: "state",
      message: "Failed to read session state; falling back to empty state",
      error: (err as Error).message,
    });
    return { sessions: {}, cwds: {} };
  }
}

function loadActiveState(): PersistedActive {
  if (!existsSync(PATHS.ACTIVE_FILE)) return { active: {}, interrupted: {} };
  try {
    const parsed = JSON.parse(readFileSync(PATHS.ACTIVE_FILE, "utf-8"));
    return { active: parsed.active || {}, interrupted: parsed.interrupted || {} };
  } catch (err) {
    writeLog("error", {
      scope: "active-state",
      message: "Failed to read active state; falling back to empty state",
      error: (err as Error).message,
    });
    return { active: {}, interrupted: {} };
  }
}

export function createStateStore() {
  const saved = loadSessions();
  const savedActive = loadActiveState();

  const threadSessions = new Map(Object.entries(saved.sessions));
  const threadCwd = new Map(Object.entries(saved.cwds));
  const activeQueries = new Map<string, ActiveQuery>(Object.entries(savedActive.active));
  const interruptedQueries = new Map<string, ActiveQuery>(Object.entries(savedActive.interrupted));

  function saveSessions(): void {
    try {
      writeFileSync(
        PATHS.STATE_FILE,
        JSON.stringify(
          { sessions: Object.fromEntries(threadSessions), cwds: Object.fromEntries(threadCwd) },
          null,
          2
        )
      );
    } catch (err) {
      writeLog("error", {
        scope: "state",
        message: "Failed to persist session state",
        error: (err as Error).message,
      });
      throw err;
    }
  }

  function trimInterrupted(limit = 20): void {
    const entries = [...interruptedQueries.entries()].sort((a, b) =>
      (b[1].interruptedAt || "").localeCompare(a[1].interruptedAt || "")
    );
    interruptedQueries.clear();
    for (const [threadTs, value] of entries.slice(0, limit)) {
      interruptedQueries.set(threadTs, value);
    }
  }

  function saveActive(): void {
    trimInterrupted();
    try {
      writeFileSync(
        PATHS.ACTIVE_FILE,
        JSON.stringify(
          {
            active: Object.fromEntries(activeQueries),
            interrupted: Object.fromEntries(interruptedQueries),
          },
          null,
          2
        )
      );
    } catch (err) {
      writeLog("error", {
        scope: "active-state",
        message: "Failed to persist active state",
        error: (err as Error).message,
      });
      throw err;
    }
  }

  function acquireProcessLock(): void {
    try {
      const fd = openSync(PATHS.PID_FILE, "wx");
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const existingPid = parseInt(readFileSync(PATHS.PID_FILE, "utf-8"), 10);
    if (Number.isInteger(existingPid)) {
      try {
        process.kill(existingPid, 0);
        throw new Error(`Another bot instance is already running with PID ${existingPid}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    }

    try {
      unlinkSync(PATHS.PID_FILE);
    } catch {}

    acquireProcessLock();
  }

  function releaseProcessLock(): void {
    try {
      const ownerPid = parseInt(readFileSync(PATHS.PID_FILE, "utf-8"), 10);
      if (ownerPid === process.pid) unlinkSync(PATHS.PID_FILE);
    } catch {}
  }

  function markRecoveredQueriesAsInterrupted(): void {
    if (activeQueries.size === 0) return;
    const interruptedAt = new Date().toISOString();
    for (const [threadTs, value] of activeQueries.entries()) {
      interruptedQueries.set(threadTs, {
        ...value,
        status: "interrupted",
        interruptedAt,
        reason: "Bot restarted before query completed",
      });
      writeLog("error", {
        scope: "active-state",
        threadTs,
        message: "Recovered stale active query after restart",
        sessionId: value.sessionId || null,
        startedAt: value.startedAt || null,
      });
    }
    activeQueries.clear();
    saveActive();
  }

  function setActiveQuery(threadTs: string, value: ActiveQuery): void {
    activeQueries.set(threadTs, value);
    interruptedQueries.delete(threadTs);
    saveActive();
  }

  function updateActiveQuery(threadTs: string, patch: Partial<ActiveQuery>): void {
    const current = activeQueries.get(threadTs);
    if (!current) return;
    activeQueries.set(threadTs, { ...current, ...patch });
    saveActive();
  }

  function failActiveQuery(threadTs: string, patch: Partial<ActiveQuery>): void {
    const current = activeQueries.get(threadTs) || { threadTs };
    interruptedQueries.set(threadTs, { ...current, ...patch, status: patch.status || "failed" });
    activeQueries.delete(threadTs);
    saveActive();
  }

  function completeActiveQuery(threadTs: string): void {
    if (!activeQueries.has(threadTs)) return;
    activeQueries.delete(threadTs);
    saveActive();
  }

  function formatStatusText(): string {
    const lines: string[] = [];
    if (activeQueries.size === 0) {
      lines.push("*Active:* none");
    } else {
      lines.push("*Active:*");
      for (const [threadTs, item] of activeQueries.entries()) {
        lines.push(`• ${threadTs} — ${item.phase || "running"} — started ${item.startedAt || "unknown"}`);
        if (item.text) lines.push(`  prompt: ${item.text.slice(0, 120)}`);
      }
    }

    const recentInterrupted = [...interruptedQueries.entries()]
      .sort((a, b) => (b[1].interruptedAt || "").localeCompare(a[1].interruptedAt || ""))
      .slice(0, 5);

    if (recentInterrupted.length === 0) {
      lines.push("*Interrupted:* none");
    } else {
      lines.push("*Interrupted (recent):*");
      for (const [threadTs, item] of recentInterrupted) {
        lines.push(`• ${threadTs} — ${item.reason || "interrupted"} — ${item.interruptedAt || "unknown"}`);
      }
    }

    return lines.join("\n");
  }

  return {
    threadSessions,
    threadCwd,
    activeQueries,
    interruptedQueries,
    saveSessions,
    acquireProcessLock,
    releaseProcessLock,
    markRecoveredQueriesAsInterrupted,
    setActiveQuery,
    updateActiveQuery,
    failActiveQuery,
    completeActiveQuery,
    formatStatusText,
  };
}
