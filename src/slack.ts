import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "./config.js";
import { writeLog } from "./logger.js";
import type { SlackApp, SlackFile } from "./types.js";

const ATTACHMENTS_DIR = join(PATHS.DATA_DIR, "attachments");
mkdirSync(ATTACHMENTS_DIR, { recursive: true });

const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

export function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

export async function downloadSlackFiles(files: SlackFile[], botToken: string): Promise<string[]> {
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

export async function fetchThreadContext(
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

export async function setTypingStatus(app: SlackApp, channel: string, threadTs: string, status: string): Promise<void> {
  try {
    await app.client.assistant.threads.setStatus({ channel_id: channel, thread_ts: threadTs, status });
  } catch {
    // assistant.threads.setStatus may not be available — silently ignore
  }
}
