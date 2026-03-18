import { query } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CWD, MAX_ERROR_DETAIL_CHARS, MAX_TURNS, PATHS } from "./config.js";
import { buildCompletedTraceBlocks, buildProgressBlocks, formatResultBlocks, formatToolDetail } from "./formatting.js";
import { logThread, writeLog } from "./logger.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import type { BotEvent, SayFn, SlackFile } from "./types.js";

type StateStore = ReturnType<typeof import("./state.js").createStateStore>;
type SlackApp = {
  client: {
    assistant: {
      threads: {
        setStatus(args: { channel_id: string; thread_ts: string; status: string }): Promise<unknown>;
      };
    };
    chat: {
      update(args: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<unknown>;
    };
    conversations: {
      replies(args: { channel: string; ts: string; limit?: number }): Promise<{
        messages?: Array<{ user?: string; bot_id?: string; text?: string; ts: string }>;
      }>;
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

const ATTACHMENTS_DIR = join(PATHS.DATA_DIR, "attachments");
mkdirSync(ATTACHMENTS_DIR, { recursive: true });

const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

async function downloadSlackFiles(files: SlackFile[], botToken: string): Promise<string[]> {
  const paths: string[] = [];
  for (const file of files) {
    if (!file.url_private) continue;
    const ext = file.filetype || "bin";
    if (!IMAGE_TYPES.has(ext)) continue;
    try {
      const resp = await fetch(file.url_private, {
        headers: { Authorization: `Bearer ${botToken}` },
      });
      if (!resp.ok) {
        writeLog("error", { scope: "attachment", message: "Download failed", fileId: file.id, status: resp.status });
        continue;
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      const filename = `${file.id}.${ext}`;
      const filepath = join(ATTACHMENTS_DIR, filename);
      writeFileSync(filepath, buffer);
      paths.push(filepath);
    } catch (err) {
      writeLog("error", { scope: "attachment", message: "Download error", fileId: file.id, error: (err as Error).message });
    }
  }
  return paths;
}

async function fetchThreadContext(
  app: SlackApp,
  channel: string,
  threadTs: string,
  currentTs: string,
  hasSession: boolean
): Promise<string | null> {
  try {
    const result = await app.client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 50,
    });
    const allMessages = (result.messages || []).filter((m) => m.ts !== currentTs);

    // Find the last bot message and only take messages after it
    let lastBotIndex = -1;
    for (let i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i].bot_id) {
        lastBotIndex = i;
        break;
      }
    }
    const relevantMessages = allMessages.slice(lastBotIndex + 1);

    const lines = relevantMessages
      .filter((m) => !m.bot_id)
      .map((m) => `<${m.user || "unknown"}>: ${stripMention(m.text || "")}`)
      .filter((line) => line.trim());
    if (lines.length === 0) return null;

    const label = hasSession
      ? "New messages in the thread since your last reply:"
      : "Here is the Slack thread context you were tagged into:";
    return `${label}\n\n${lines.join("\n")}`;
  } catch (err) {
    writeLog("error", {
      scope: "thread-context",
      message: "Failed to fetch thread history",
      error: (err as Error).message,
    });
    return null;
  }
}

async function setTypingStatus(app: SlackApp, channel: string, threadTs: string, status: string): Promise<void> {
  try {
    await app.client.assistant.threads.setStatus({ channel_id: channel, thread_ts: threadTs, status });
  } catch {
    // assistant.threads.setStatus may not be available — silently ignore
  }
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

    if (text.trim() === "/restart") {
      await say({ text: ":arrows_counterclockwise: Restarting bot...", thread_ts: threadTs });
      logThread(threadTs, "User requested restart via /restart");
      const { execSync } = await import("node:child_process");
      execSync(`${PATHS.ROOT_DIR}/restart-bot.sh`, { cwd: PATHS.ROOT_DIR, timeout: 15000 });
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

    await setTypingStatus(app, event.channel, threadTs, "is thinking...");

    const thinking = await say({
      text: "Working on it...",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: ":hourglass_flowing_sand: *Working on it...*" } }],
      thread_ts: threadTs,
    });
    logThread(threadTs, "Posted thinking message", { thinkingTs: thinking.ts });
    state.updateActiveQuery(threadTs, { phase: "running", thinkingTs: thinking.ts });

    let sessionId = existingSessionId;
    const completedTools: Array<{ name: string; detail: string }> = [];
    let currentTool: { name: string; detail: string } | null = null;
    const queryStartTime = Date.now();

    // Periodic timer to keep elapsed time fresh even between tool calls
    const progressTimer = setInterval(async () => {
      try {
        await app.client.chat.update({
          channel: event.channel,
          ts: thinking.ts,
          text: "Working on it...",
          blocks: buildProgressBlocks(completedTools, currentTool, queryStartTime),
        });
      } catch {}
    }, 5000);

    try {
      let resultText = "";
      let claudeErrorExcerpt = "";
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

      // Download image attachments
      let attachmentNote = "";
      if (event.files?.length) {
        const botToken = process.env.SLACK_BOT_TOKEN;
        if (botToken) {
          const imagePaths = await downloadSlackFiles(event.files, botToken);
          if (imagePaths.length > 0) {
            attachmentNote = `\n\nThe user attached ${imagePaths.length} image(s). Read them with the Read tool:\n${imagePaths.map((p) => `- ${p}`).join("\n")}`;
            logThread(threadTs, "Downloaded image attachments", { count: imagePaths.length, paths: imagePaths });
          }
        }
      }

      // Fetch missed thread messages (new session: full context, existing session: since last bot reply)
      let prompt = text + attachmentNote;
      if (event.thread_ts) {
        const threadContext = await fetchThreadContext(app, event.channel, threadTs, event.ts, !!existingSessionId);
        if (threadContext) {
          prompt = `${threadContext}\n\n---\n\nUser's request: ${text}${attachmentNote}`;
          logThread(threadTs, "Prepended thread context to prompt", { hasSession: !!existingSessionId });
        }
      }

      for await (const message of query({ prompt, options })) {
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
              const statusText = currentTool
                ? `is running ${currentTool.name}...`
                : "is thinking...";
              await setTypingStatus(app, event.channel, threadTs, statusText);
              await app.client.chat.update({
                channel: event.channel,
                ts: thinking.ts,
                text: "Working on it...",
                blocks: buildProgressBlocks(completedTools, currentTool, queryStartTime),
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

      clearInterval(progressTimer);

      if (sessionId) {
        state.threadSessions.set(threadTs, sessionId);
        state.saveSessions();
      }

      // Push the last tool into completed list for the final trace
      if (currentTool) {
        completedTools.push(currentTool);
        currentTool = null;
      }

      logThread(threadTs, "Claude query completed", {
        sessionId,
        resultChars: resultText.length,
        resultText,
      });
      state.completeActiveQuery(threadTs);

      const elapsedMs = Date.now() - queryStartTime;

      // Clear typing status
      await setTypingStatus(app, event.channel, threadTs, "");

      // Update thinking message to show completed trace
      await app.client.chat.update({
        channel: event.channel,
        ts: thinking.ts,
        text: "Done",
        blocks: buildCompletedTraceBlocks(completedTools, elapsedMs),
      });

      // Post result as a new message
      const fallbackText = resultText || "(no output)";
      await say({
        text: fallbackText,
        blocks: formatResultBlocks(resultText),
        thread_ts: threadTs,
      });
      logThread(threadTs, "Posted result as new message", {
        channel: event.channel,
        thinkingTs: thinking.ts,
        text: fallbackText,
      });
    } catch (err) {
      clearInterval(progressTimer);
      await setTypingStatus(app, event.channel, threadTs, "");
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
