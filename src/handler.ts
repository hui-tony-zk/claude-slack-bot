import { decodeSessionId, encodeSessionId, getProviderModel, runAgentQuery } from "./agents.js";
import type { AgentProvider, BuiltPrompt, ToolTrace } from "./agents.js";
import { AGENT_PROVIDER, DEFAULT_CWD, MAX_ERROR_DETAIL_CHARS } from "./config.js";
import { handleCommand } from "./commands.js";
import { buildCompletedTraceBlocks, buildProgressBlocks, formatResultBlocks } from "./formatting.js";
import { logThread, writeLog } from "./logger.js";
import { downloadSlackFiles, extractImagePaths, fetchThreadContext, setTypingStatus, stripAttachmentLines, stripMention, uploadFileToThread } from "./slack.js";
import type { BotEvent, SayFn, SlackApp } from "./types.js";

type StateStore = ReturnType<typeof import("./state.js").createStateStore>;

async function buildPrompt(
  app: SlackApp,
  event: BotEvent,
  text: string,
  threadTs: string,
  hasSession: boolean
): Promise<BuiltPrompt> {
  // Download image attachments
  let attachmentNote = "";
  let imagePaths: string[] = [];
  if (event.files?.length) {
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (botToken) {
      imagePaths = await downloadSlackFiles(event.files, botToken);
      if (imagePaths.length > 0) {
        attachmentNote = `\n\nThe user attached ${imagePaths.length} image(s):\n${imagePaths.map((p) => `- ${p}`).join("\n")}`;
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

  return { text: prompt, imagePaths };
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

    const { handled } = await handleCommand(text.trim(), threadTs, event.channel, say, state);
    if (handled) return;

    const cwd = state.threadCwd.get(threadTs) || DEFAULT_CWD;
    const storedSessionId = state.threadSessions.get(threadTs);
    const provider = AGENT_PROVIDER as AgentProvider;
    const existingSessionId = decodeSessionId(provider, storedSessionId);
    const providerModel = getProviderModel(provider);

    logThread(threadTs, `Starting ${provider} query`, { cwd, model: providerModel || null, sessionId: existingSessionId || null });
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
      provider,
    });

    await setTypingStatus(app, event.channel, threadTs, "is thinking...");

    const queryStartTime = Date.now();
    const thinking = await say({
      text: "Working",
      blocks: buildProgressBlocks([], null, queryStartTime),
      thread_ts: threadTs,
    });
    logThread(threadTs, "Posted thinking message", { thinkingTs: thinking.ts });
    state.updateActiveQuery(threadTs, { phase: "running", thinkingTs: thinking.ts });

    let sessionId = existingSessionId;
    const completedTools: ToolTrace[] = [];
    let currentTool: ToolTrace | null = null;
    let lastTool: ToolTrace | null = null;

    const progressTimer = setInterval(async () => {
      try {
        await app.client.chat.update({
          channel: event.channel,
          ts: thinking.ts,
          text: "Working",
          blocks: buildProgressBlocks(completedTools, currentTool, queryStartTime, lastTool),
        });
      } catch {}
    }, 5000);

    try {
      const prompt = await buildPrompt(app, event, text, threadTs, !!existingSessionId);
      let lastProgressUpdate = 0;
      const onSession = (newSessionId: string) => {
        sessionId = newSessionId;
        state.updateActiveQuery(threadTs, { sessionId, phase: "initialized" });
      };
      const onTool = (tool: ToolTrace | null, completedTool?: ToolTrace) => {
        if (currentTool && completedTool === undefined && provider === "claude") {
          completedTools.push(currentTool);
        }
        if (completedTool) completedTools.push(completedTool);
        if (tool) lastTool = tool;
        else if (completedTool) lastTool = completedTool;
        currentTool = tool;
      };
      const updateProgress = async () => {
        const now = Date.now();
        if (now - lastProgressUpdate < 2000) return;
        lastProgressUpdate = now;
        try {
          const statusText = currentTool ? `is running ${currentTool.name}...` : "is thinking...";
          await setTypingStatus(app, event.channel, threadTs, statusText);
          await app.client.chat.update({
            channel: event.channel,
            ts: thinking.ts,
            text: "Working",
            blocks: buildProgressBlocks(completedTools, currentTool, queryStartTime, lastTool),
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
      };

      const resultText = await runAgentQuery(provider, {
        prompt,
        cwd,
        existingSessionId,
        threadTs,
        onSession,
        onTool: (...args) => {
          onTool(...args);
          void updateProgress();
        },
      });

      clearInterval(progressTimer);

      if (sessionId) {
        state.threadSessions.set(threadTs, encodeSessionId(provider, sessionId));
        state.saveSessions();
      }

      if (currentTool) {
        completedTools.push(currentTool);
        currentTool = null;
      }

      logThread(threadTs, `${provider} query completed`, {
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

      // Extract and upload any attached files before posting the text
      const imagePaths = extractImagePaths(resultText);
      const cleanedResult = stripAttachmentLines(resultText);

      const fallbackText = cleanedResult || "(no output)";
      await say({
        text: fallbackText,
        blocks: formatResultBlocks(cleanedResult),
        thread_ts: threadTs,
      });
      logThread(threadTs, "Posted result as new message", {
        channel: event.channel,
        thinkingTs: thinking.ts,
        text: fallbackText,
      });

      if (imagePaths.length > 0) {
        logThread(threadTs, "Uploading images from result", { count: imagePaths.length, paths: imagePaths });
        for (const imgPath of imagePaths) {
          await uploadFileToThread(app, event.channel, threadTs, imgPath);
        }
      }
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
        message: `${provider} query failed`,
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
