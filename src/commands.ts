import { PATHS } from "./config.js";
import { logThread } from "./logger.js";
import type { SayFn } from "./types.js";

type StateStore = ReturnType<typeof import("./state.js").createStateStore>;

export type CommandResult = { handled: boolean };

export async function handleCommand(
  text: string,
  threadTs: string,
  say: SayFn,
  state: StateStore
): Promise<CommandResult> {
  if (text === "/status") {
    const statusText = state.formatStatusText();
    logThread(threadTs, "Reported status snapshot", {
      activeCount: state.activeQueries.size,
      interruptedCount: state.interruptedQueries.size,
    });
    await say({ text: statusText, thread_ts: threadTs });
    return { handled: true };
  }

  const cwdMatch = text.match(/^\/cwd\s+(.+)/);
  if (cwdMatch) {
    const newCwd = cwdMatch[1].trim();
    state.threadCwd.set(threadTs, newCwd);
    state.saveSessions();
    logThread(threadTs, "Working directory changed", { cwd: newCwd });
    await say({ text: `Working directory set to \`${newCwd}\``, thread_ts: threadTs });
    return { handled: true };
  }

  if (text === "/new") {
    state.threadSessions.delete(threadTs);
    state.saveSessions();
    logThread(threadTs, "Session cleared by user");
    await say({ text: "Session cleared. Next message starts a fresh session.", thread_ts: threadTs });
    return { handled: true };
  }

  if (text === "/restart") {
    await say({ text: ":arrows_counterclockwise: Restarting bot...", thread_ts: threadTs });
    logThread(threadTs, "User requested restart via /restart");
    const { execSync } = await import("node:child_process");
    execSync(`${PATHS.ROOT_DIR}/restart-bot.sh`, { cwd: PATHS.ROOT_DIR, timeout: 15000 });
    return { handled: true };
  }

  return { handled: false };
}
