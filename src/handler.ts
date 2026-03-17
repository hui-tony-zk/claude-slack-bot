import { query } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_CWD, MAX_ERROR_DETAIL_CHARS, MAX_TURNS } from "./config.js";
import { buildProgressBlocks, formatResultBlocks, formatToolDetail } from "./formatting.js";
import { logThread, writeLog } from "./logger.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import type { BotEvent, SayFn } from "./types.js";

type StateStore = ReturnType<typeof import("./state.js").createStateStore>;
type SlackApp = {
  client: {
    chat: {
      update(args: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<unknown>;
    };
  };
};

function buildClaudeEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== "CLAUDECODE" && !key.startsWith("CLAUDE_CODE_") && typeof value === "string"
    )
  ) as Record<string, string>;
}

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

export function createMessageHandler(app: SlackApp, state: StateStore) {
  return async function handleMessage({ event, say }: { event: BotEvent; say: SayFn }): Promise<void> {
    const threadTs = event.thread_ts || event.ts;
    const text = stripMention(event.text);
    const user = event.user;

    logThread(threadTs, "Incoming user message", {
      user,
      channel: event.channel,
      text,
      slackTs: event.ts,
    });

    if (!text.trim()) {
      await say({ text: "Give me a task!", thread_ts: threadTs });
      logThread(threadTs, "Rejected empty message");
      return;
    }

    if (text.trim() === "/status") {
      const statusText = state.formatStatusText();
      logThread(threadTs, "Reported status snapshot", {
        activeCount: state.activeQueries.size,
        interruptedCount: state.interruptedQueries.size,
      });
      await say({ text: statusText, thread_ts: threadTs });
      return;
    }

    const cwdMatch = text.match(/^\/cwd\s+(.+)/);
    if (cwdMatch) {
      const newCwd = cwdMatch[1].trim();
      state.threadCwd.set(threadTs, newCwd);
      state.saveSessions();
      logThread(threadTs, "Working directory changed", { cwd: newCwd });
      await say({ text: `Working directory set to \`${newCwd}\``, thread_ts: threadTs });
      return;
    }

    if (text.trim() === "/new") {
      state.threadSessions.delete(threadTs);
      state.saveSessions();
      logThread(threadTs, "Session cleared by user");
      await say({ text: "Session cleared. Next message starts a fresh session.", thread_ts: threadTs });
      return;
    }

    const cwd = state.threadCwd.get(threadTs) || DEFAULT_CWD;
    const existingSessionId = state.threadSessions.get(threadTs);

    logThread(threadTs, "Starting Claude query", {
      cwd,
      sessionId: existingSessionId || null,
    });
    state.setActiveQuery(threadTs, {
      threadTs,
      user,
      channel: event.channel,
      text,
      cwd,
      sessionId: existingSessionId || null,
      startedAt: new Date().toISOString(),
      phase: "starting",
      thinkingTs: null,
    });

    const thinking = await say({
      text: "Working on it...",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: ":hourglass_flowing_sand: *Working on it...*" } }],
      thread_ts: threadTs,
    });
    logThread(threadTs, "Posted thinking message", { thinkingTs: thinking.ts });
    state.updateActiveQuery(threadTs, { phase: "running", thinkingTs: thinking.ts });

    let sessionId = existingSessionId;

    try {
      let resultText = "";
      let claudeErrorExcerpt = "";
      const completedTools: Array<{ name: string; detail: string }> = [];
      let currentTool: { name: string; detail: string } | null = null;
      let lastProgressUpdate = 0;

      const options: Record<string, unknown> = {
        cwd,
        env: buildClaudeEnv(),
        systemPrompt: SYSTEM_PROMPT,
        allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent", "WebFetch", "WebSearch"],
        maxTurns: MAX_TURNS,
        permissionMode: "bypassPermissions",
        stderr: (data: string) => {
          writeLog("error", {
            scope: "claude-stderr",
            threadTs,
            message: "Claude subprocess stderr",
            data,
          });
          if (claudeErrorExcerpt.length < MAX_ERROR_DETAIL_CHARS) {
            claudeErrorExcerpt += data.slice(0, MAX_ERROR_DETAIL_CHARS - claudeErrorExcerpt.length);
          }
        },
      };

      if (existingSessionId) options.resume = existingSessionId;

      for await (const message of query({ prompt: text, options })) {
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
          logThread(threadTs, "Claude session initialized", { sessionId });
          state.updateActiveQuery(threadTs, { sessionId, phase: "initialized" });
        }

        if (message.type === "assistant") {
          const content = message.message?.content || [];
          for (const block of content) {
            if (block.type !== "tool_use") continue;
            if (currentTool) completedTools.push(currentTool);
            currentTool = {
              name: block.name,
              detail: formatToolDetail(block.name, block.input),
            };
            const now = Date.now();
            if (now - lastProgressUpdate < 2000) continue;
            lastProgressUpdate = now;
            try {
              await app.client.chat.update({
                channel: event.channel,
                ts: thinking.ts,
                text: "Working on it...",
                blocks: buildProgressBlocks(completedTools, currentTool),
              });
              state.updateActiveQuery(threadTs, {
                phase: currentTool ? `tool:${currentTool.name}` : "running",
                currentTool,
                completedTools: completedTools.slice(-10),
                lastProgressAt: new Date(now).toISOString(),
              });
            } catch (err) {
              logThread(threadTs, "Progress update failed", { error: (err as Error).message });
            }
          }
        }

        if (message.type === "result" && message.subtype === "success") resultText = message.result || "";
        if (message.type === "result" && message.subtype !== "success") {
          const errorMessage = (message as any).error || (message as any).message || "Unknown error";
          resultText = `:x: Error: ${errorMessage}`;
        }
      }

      if (sessionId) {
        state.threadSessions.set(threadTs, sessionId);
        state.saveSessions();
      }

      logThread(threadTs, "Claude query completed", {
        sessionId,
        resultChars: resultText.length,
        resultText,
      });
      state.completeActiveQuery(threadTs);

      const fallbackText = resultText || "(no output)";
      await app.client.chat.update({
        channel: event.channel,
        ts: thinking.ts,
        text: fallbackText,
        blocks: formatResultBlocks(resultText),
      });
      logThread(threadTs, "Updated Slack reply", {
        channel: event.channel,
        slackTs: thinking.ts,
        text: fallbackText,
      });
    } catch (err) {
      const detail = [String((err as any).stderr || ""), String((err as any).stdout || "")]
        .filter(Boolean)
        .join("\n")
        .trim();
      const errorDetail = [detail].filter(Boolean).join("\n").trim();
      writeLog("error", {
        scope: "thread",
        threadTs,
        message: "Claude query failed",
        error: (err as Error).message,
        detail: errorDetail,
      });
      state.failActiveQuery(threadTs, {
        sessionId,
        interruptedAt: new Date().toISOString(),
        reason: (err as Error).message,
        detail: errorDetail,
      });
      const errMsg = `:x: Failed: ${(err as Error).message}${errorDetail ? `\n\`\`\`${errorDetail.slice(0, 300)}\`\`\`` : ""}`;
      await app.client.chat.update({
        channel: event.channel,
        ts: thinking.ts,
        text: errMsg,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: errMsg } }],
      });
      logThread(threadTs, "Updated Slack reply with failure", {
        channel: event.channel,
        slackTs: thinking.ts,
        error: (err as Error).message,
        detail: errorDetail,
      });
    }
  };
}
