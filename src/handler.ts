import { query } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_CWD, MAX_ERROR_DETAIL_CHARS, MAX_TURNS } from "./config.js";
import { handleCommand } from "./commands.js";
import { buildCompletedTraceBlocks, buildProgressBlocks, formatResultBlocks, formatToolDetail } from "./formatting.js";
import { logThread, writeLog } from "./logger.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { downloadSlackFiles, fetchThreadContext, setTypingStatus, stripMention } from "./slack.js";
import type { BotEvent, SayFn, SlackApp } from "./types.js";

type StateStore = ReturnType<typeof import("./state.js").createStateStore>;

function buildClaudeEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== "CLAUDECODE" && !key.startsWith("CLAUDE_CODE_") && typeof value === "string"
    )
  ) as Record<string, string>;
}

async function buildPrompt(
  app: SlackApp,
  event: BotEvent,
  text: string,
  threadTs: string,
  hasSession: boolean
): Promise<string> {
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

  // Fetch missed thread messages
  let prompt = text + attachmentNote;
  if (event.thread_ts) {
    const threadContext = await fetchThreadContext(app, event.channel, threadTs, event.ts, hasSession);
    if (threadContext) {
      prompt = `${threadContext}\n\n---\n\nUser's request: ${text}${attachmentNote}`;
      logThread(threadTs, "Prepended thread context to prompt", { hasSession });
    }
  }

  return prompt;
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

    const { handled } = await handleCommand(text.trim(), threadTs, say, state);
    if (handled) return;

    const cwd = state.threadCwd.get(threadTs) || DEFAULT_CWD;
    const existingSessionId = state.threadSessions.get(threadTs);

    logThread(threadTs, "Starting Claude query", { cwd, sessionId: existingSessionId || null });
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

      const prompt = await buildPrompt(app, event, text, threadTs, !!existingSessionId);

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

      await setTypingStatus(app, event.channel, threadTs, "");

      await app.client.chat.update({
        channel: event.channel,
        ts: thinking.ts,
        text: "Done",
        blocks: buildCompletedTraceBlocks(completedTools, elapsedMs),
      });

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
