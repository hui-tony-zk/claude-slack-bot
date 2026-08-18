import { createWriteStream, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PATHS } from "./config.js";
import { writeLog } from "./logger.js";
import type { ToolTrace } from "./agents.js";
import type { SlackApp, SlackFile, SlackStreamChunk } from "./types.js";

const ATTACHMENTS_DIR = join(PATHS.DATA_DIR, "attachments");
mkdirSync(ATTACHMENTS_DIR, { recursive: true });

const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const VIDEO_TYPES = new Set(["mp4", "mov", "m4v", "webm", "avi", "mkv", "mpg", "mpeg", "qt"]);
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/x-msvideo": "avi",
};

export type DownloadedSlackFiles = {
  imagePaths: string[];
  videoPaths: string[];
};

export function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

function getAttachmentType(file: SlackFile): { ext: string; kind: "image" | "video" } | null {
  const rawExt = file.filetype || file.name?.split(".").pop() || "";
  const safeExt = rawExt.toLowerCase().replace(/[^a-z0-9]/g, "");
  const mime = file.mimetype?.toLowerCase() || "";
  const ext = MIME_EXTENSIONS[mime] || safeExt || "bin";

  if (mime.startsWith("image/") || IMAGE_TYPES.has(ext)) return { ext, kind: "image" };
  if (mime.startsWith("video/") || VIDEO_TYPES.has(ext)) return { ext, kind: "video" };
  return null;
}

export async function downloadSlackFiles(files: SlackFile[], botToken: string): Promise<DownloadedSlackFiles> {
  const downloaded: DownloadedSlackFiles = { imagePaths: [], videoPaths: [] };
  for (const file of files) {
    if (!file.url_private) continue;
    const attachmentType = getAttachmentType(file);
    if (!attachmentType) continue;
    const { ext, kind } = attachmentType;
    const filename = `${file.id}.${ext}`;
    const filepath = join(ATTACHMENTS_DIR, filename);
    try {
      const resp = await fetch(file.url_private, {
        headers: { Authorization: `Bearer ${botToken}` },
      });
      if (!resp.ok) {
        writeLog("error", { scope: "attachment", message: "Download failed", fileId: file.id, status: resp.status });
        continue;
      }
      if (!resp.body) throw new Error("Download response had no body");
      await pipeline(Readable.fromWeb(resp.body as any), createWriteStream(filepath));
      downloaded[kind === "image" ? "imagePaths" : "videoPaths"].push(filepath);
    } catch (err) {
      try {
        unlinkSync(filepath);
      } catch {}
      writeLog("error", { scope: "attachment", message: "Download error", fileId: file.id, error: (err as Error).message });
    }
  }
  return downloaded;
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

const UPLOADABLE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "pdf",
  "mp4", "mov", "m4v", "webm", "avi", "mkv", "mpg", "mpeg", "qt",
  "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "aif", "aiff",
]);

export function isUploadableFilePath(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return UPLOADABLE_EXTENSIONS.has(ext);
}

/** Extract file paths from structured "📎 /path/to/file" lines in the result text. */
export function extractAttachmentPaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^📎\s+(\/.+?)\s*$/);
    if (match && existsSync(match[1])) paths.push(match[1]);
  }
  return [...new Set(paths)];
}

/** Strip "📎 /path" lines from text before sending to Slack. */
export function stripAttachmentLines(text: string): string {
  return text.split("\n").filter((line) => !line.match(/^📎\s+\//)).join("\n").trimEnd();
}

/** Upload a file to a Slack thread. */
export async function uploadFileToThread(
  app: SlackApp,
  channel: string,
  threadTs: string,
  filePath: string,
  title?: string,
): Promise<void> {
  if (!isUploadableFilePath(filePath)) {
    writeLog("error", {
      scope: "upload",
      message: "Skipped file with unsupported extension",
      filePath,
      channel,
      threadTs,
    });
    return;
  }

  try {
    await app.client.files.uploadV2({
      channel_id: channel,
      thread_ts: threadTs,
      file: filePath,
      filename: basename(filePath),
      title: title || basename(filePath),
    });
    writeLog("info", { scope: "upload", message: "Uploaded file to Slack", filePath, channel, threadTs });
  } catch (err) {
    writeLog("error", { scope: "upload", message: "File upload failed", filePath, error: (err as Error).message });
  }
}

export async function setTypingStatus(app: SlackApp, channel: string, threadTs: string, status: string): Promise<void> {
  try {
    await app.client.assistant.threads.setStatus({ channel_id: channel, thread_ts: threadTs, status });
  } catch {
    // assistant.threads.setStatus may not be available — silently ignore
  }
}

function truncateTaskText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

function taskChunk(tool: ToolTrace, status: "in_progress" | "complete" | "error"): SlackStreamChunk {
  return {
    type: "task_update",
    id: tool.id,
    title: truncateTaskText(tool.name, 80),
    status,
    ...(tool.detail ? { details: truncateTaskText(tool.detail, 500) } : {}),
  };
}

export type NativeTaskProgress = {
  ts: string | null;
  update(tool: ToolTrace, status: "in_progress" | "complete" | "error"): void;
  addMessage(id: string, text: string): void;
  stop(title: string): Promise<void>;
};

/** Render agent tool activity with Slack's native plan/task streaming UI. */
export async function startNativeTaskProgress(
  app: SlackApp,
  channel: string,
  threadTs: string,
  recipientUserId: string,
  recipientTeamId?: string,
): Promise<NativeTaskProgress> {
  let streamTs: string | null = null;
  let stopped = false;
  let queue = Promise.resolve();
  let lastTask: { id: string; title: string } | null = null;
  const displayIds = new Map<string, string>();
  const lastTaskState = new Map<string, string>();

  try {
    const response = await app.client.chat.startStream({
      channel,
      thread_ts: threadTs,
      task_display_mode: "plan",
      chunks: [{ type: "plan_update", title: "Working" }],
      recipient_user_id: recipientUserId,
      ...(recipientTeamId ? { recipient_team_id: recipientTeamId } : {}),
    });
    streamTs = response.ts || null;
    if (!streamTs) throw new Error("chat.startStream returned no message timestamp");
  } catch (err) {
    writeLog("error", {
      scope: "native-task-progress",
      threadTs,
      message: "Failed to start native task progress",
      error: (err as Error).message,
    });
  }

  return {
    ts: streamTs,
    update(tool, status) {
      if (!streamTs || stopped) return;
      let displayId = displayIds.get(tool.id);
      if (!displayId) {
        displayId = lastTask?.title === tool.name ? lastTask.id : tool.id;
        displayIds.set(tool.id, displayId);
      }
      const displayTool = displayId === tool.id ? tool : { ...tool, id: displayId };
      const signature = `${status}\n${displayTool.name}\n${displayTool.detail}`;
      if (lastTaskState.get(displayId) === signature) return;
      lastTaskState.set(displayId, signature);
      lastTask = { id: displayId, title: displayTool.name };
      queue = queue
        .then(() => app.client.chat.appendStream({
          channel,
          ts: streamTs as string,
          chunks: [taskChunk(displayTool, status)],
        }))
        .then(() => undefined)
        .catch((err) => {
          writeLog("error", {
            scope: "native-task-progress",
            threadTs,
            message: "Failed to update native task progress",
            error: (err as Error).message,
          });
        });
    },
    addMessage(id, text) {
      if (!streamTs || stopped) return;
      const normalized = text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[*_`#>]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!normalized) return;
      const messageTask: ToolTrace = {
        id: `message:${id}`,
        name: truncateTaskText(normalized, 120),
        detail: "",
      };
      queue = queue
        .then(() => app.client.chat.appendStream({
          channel,
          ts: streamTs as string,
          chunks: [taskChunk(messageTask, "complete")],
        }))
        .then(() => undefined)
        .catch((err) => {
          writeLog("error", {
            scope: "native-task-progress",
            threadTs,
            message: "Failed to add native progress message",
            error: (err as Error).message,
          });
        });
    },
    async stop(title) {
      if (!streamTs || stopped) return;
      stopped = true;
      await queue;
      try {
        await app.client.chat.stopStream({
          channel,
          ts: streamTs,
          chunks: [{ type: "plan_update", title }],
        });
      } catch (err) {
        writeLog("error", {
          scope: "native-task-progress",
          threadTs,
          message: "Failed to stop native task progress",
          error: (err as Error).message,
        });
      }
    },
  };
}
