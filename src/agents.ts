import { query } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";
import type { ApprovalMode, Input, ModelReasoningEffort, SandboxMode, ThreadItem } from "@openai/codex-sdk";
import { CLAUDE_MODEL, CODEX_MODEL_REASONING_EFFORT, DEFAULT_MODEL, MAX_TURNS } from "./config.js";
import { formatToolDetail } from "./formatting.js";
import { logThread, serializeError, writeLog } from "./logger.js";
import { SYSTEM_PROMPT } from "./prompt.js";

export type AgentProvider = "codex" | "claude";

export type BuiltPrompt = {
  text: string;
  imagePaths: string[];
};

export type ToolTrace = { id: string; name: string; detail: string };

type RunAgentArgs = {
  prompt: BuiltPrompt;
  cwd: string;
  existingSessionId: string | undefined;
  threadTs: string;
  onSession: (sessionId: string) => void;
  onTool: (
    tool: ToolTrace | null,
    completedTool?: ToolTrace,
    completedStatus?: "complete" | "error",
  ) => void;
  onAgentMessage?: (id: string, text: string) => void;
};

const CODEX_SESSION_PREFIX = "codex:";
const CLAUDE_SESSION_PREFIX = "claude:";
const VALID_SANDBOX_MODES = new Set<SandboxMode>(["read-only", "workspace-write", "danger-full-access"]);
const VALID_APPROVAL_MODES = new Set<ApprovalMode>(["never", "on-request", "on-failure", "untrusted"]);
const VALID_REASONING_EFFORTS = new Set<ModelReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);
const MAX_CODEX_ATTEMPTS = 2;
const CODEX_RETRY_DELAY_MS = 1_000;
const RETRYABLE_CODEX_DISCONNECT = /stream disconnected before completion|websocket closed by server before response\.completed/i;

export function shouldRetryCodexTurn(error: unknown, attempt: number, sideEffectEventCount: number): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return attempt < MAX_CODEX_ATTEMPTS
    && sideEffectEventCount === 0
    && RETRYABLE_CODEX_DISCONNECT.test(message);
}

function isPotentiallySideEffectingItem(item: ThreadItem): boolean {
  return item.type === "command_execution"
    || item.type === "file_change"
    || item.type === "mcp_tool_call";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function encodeSessionId(provider: AgentProvider, sessionId: string): string {
  return `${provider === "codex" ? CODEX_SESSION_PREFIX : CLAUDE_SESSION_PREFIX}${sessionId}`;
}

export function decodeSessionId(provider: AgentProvider, storedSessionId: string | undefined): string | undefined {
  if (!storedSessionId) return undefined;
  const prefix = provider === "codex" ? CODEX_SESSION_PREFIX : CLAUDE_SESSION_PREFIX;
  if (storedSessionId.startsWith(prefix)) return storedSessionId.slice(prefix.length);
  return provider === "claude" && !storedSessionId.startsWith(CODEX_SESSION_PREFIX) ? storedSessionId : undefined;
}

export function getProviderModel(provider: AgentProvider): string | undefined {
  if (provider === "codex") return DEFAULT_MODEL;
  return CLAUDE_MODEL || undefined;
}

export async function runAgentQuery(provider: AgentProvider, args: RunAgentArgs): Promise<string> {
  return provider === "codex" ? runCodexQuery(args) : runClaudeQuery(args);
}

function buildClaudeEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== "CLAUDECODE" && !key.startsWith("CLAUDE_CODE_") && typeof value === "string"
    )
  ) as Record<string, string>;
}

function getSandboxMode(): SandboxMode {
  const mode = process.env.CODEX_SANDBOX_MODE as SandboxMode | undefined;
  return mode && VALID_SANDBOX_MODES.has(mode) ? mode : "danger-full-access";
}

function getApprovalPolicy(): ApprovalMode {
  const policy = process.env.CODEX_APPROVAL_POLICY as ApprovalMode | undefined;
  return policy && VALID_APPROVAL_MODES.has(policy) ? policy : "never";
}

function getModelReasoningEffort(): ModelReasoningEffort | undefined {
  const effort = CODEX_MODEL_REASONING_EFFORT as ModelReasoningEffort | undefined;
  return effort && VALID_REASONING_EFFORTS.has(effort) ? effort : undefined;
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/^mcp__/, "")
    .replace(/[_:-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function humanizeCommand(command: string): string {
  const normalized = command.toLowerCase();
  if (normalized.includes("ffprobe")) return "Inspecting the video";
  if (normalized.includes("ffmpeg")) return "Preparing the video";
  if (/\b(vitest|jest|pytest|npm test|pnpm test|npm run typecheck)\b/.test(normalized)) return "Checking the result";
  if (/\bgit\s+(diff|status|show)\b/.test(normalized)) return "Reviewing changes";
  if (normalized.includes("/downloads") && /\bfind\b/.test(normalized)) return "Finding downloaded media";
  if (/\b(rg|grep)\b/.test(normalized)) return "Searching local files";
  if (/\b(find|fd)\b/.test(normalized)) return "Finding local files";
  if (/\b(sed|cat|head|tail)\b/.test(normalized)) return "Reading local files";
  return "Running a local tool";
}

function humanizeMcpTool(server: string, tool: string, rawArguments: unknown): ToolTrace["name"] {
  const args = rawArguments && typeof rawArguments === "object"
    ? rawArguments as Record<string, unknown>
    : {};
  if (typeof args.title === "string" && args.title.trim()) return args.title.trim();

  const key = `${server}:${tool}`.toLowerCase();
  if (key.includes("node_repl") || key.includes("browser") || key.includes("chrome")) return "Using the browser";
  if (key.includes("video_watch") || key.includes("video_understanding")) return "Understanding the video";
  if (key.includes("process_video")) return "Analyzing the video";
  if (key.includes("web") && key.includes("search")) return "Searching the web";
  return humanizeIdentifier(tool) || "Using a connected tool";
}

function codexItemToTool(item: ThreadItem): ToolTrace | null {
  switch (item.type) {
    case "command_execution":
      return { id: item.id, name: humanizeCommand(item.command), detail: "" };
    case "file_change": {
      const paths = item.changes.map((change) => change.path.split("/").pop() || change.path);
      const singleChange = item.changes.length === 1 ? item.changes[0] : null;
      const verb = singleChange?.kind === "add" ? "Creating" : singleChange?.kind === "delete" ? "Removing" : "Updating";
      return {
        id: item.id,
        name: singleChange ? `${verb} ${paths[0]}` : `Updating ${item.changes.length} files`,
        detail: singleChange ? "" : paths.slice(0, 3).join(", "),
      };
    }
    case "mcp_tool_call": {
      const args = item.arguments && typeof item.arguments === "object"
        ? item.arguments as Record<string, unknown>
        : {};
      const hasTitle = typeof args.title === "string" && args.title.trim().length > 0;
      return {
        id: item.id,
        name: humanizeMcpTool(item.server, item.tool, item.arguments),
        detail: hasTitle ? "" : formatToolDetail(item.tool, args),
      };
    }
    case "web_search":
      return { id: item.id, name: "Searching the web", detail: item.query };
    case "todo_list": {
      const completed = item.items.filter((todo) => todo.completed).length;
      const current = item.items.find((todo) => !todo.completed);
      return {
        id: item.id,
        name: current?.text || "Plan complete",
        detail: `${completed}/${item.items.length} steps complete`,
      };
    }
    default:
      return null;
  }
}

function completedToolStatus(item: ThreadItem): "complete" | "error" {
  if (item.type === "command_execution" || item.type === "file_change" || item.type === "mcp_tool_call") {
    return item.status === "failed" ? "error" : "complete";
  }
  return "complete";
}

function buildCodexInput(prompt: BuiltPrompt): Input {
  const text = `${SYSTEM_PROMPT}\n\n---\n\n${prompt.text}`;
  if (!prompt.imagePaths.length) return text;
  return [
    { type: "text", text },
    ...prompt.imagePaths.map((path) => ({ type: "local_image" as const, path })),
  ];
}

async function runCodexQuery(args: RunAgentArgs): Promise<string> {
  const codexPathOverride = process.env.CODEX_PATH?.trim() || undefined;
  const codex = new Codex(codexPathOverride ? { codexPathOverride } : {});
  const threadOptions = {
    model: DEFAULT_MODEL,
    workingDirectory: args.cwd,
    sandboxMode: getSandboxMode(),
    approvalPolicy: getApprovalPolicy(),
    skipGitRepoCheck: true,
    modelReasoningEffort: getModelReasoningEffort(),
  };
  let activeSessionId = args.existingSessionId;

  for (let attempt = 1; attempt <= MAX_CODEX_ATTEMPTS; attempt += 1) {
    let resultText = "";
    let itemEventCount = 0;
    let sideEffectEventCount = 0;
    let eventCount = 0;
    let turnCompleted = false;
    let lastStreamError: string | null = null;
    const eventTypeCounts: Record<string, number> = {};
    const itemTypeCounts: Record<string, number> = {};
    const runningTools = new Map<string, ToolTrace>();
    const attemptStartedAt = Date.now();
    const thread = activeSessionId
      ? codex.resumeThread(activeSessionId, threadOptions)
      : codex.startThread(threadOptions);

    try {
      const { events } = await thread.runStreamed(buildCodexInput(args.prompt));
      for await (const message of events) {
        eventCount += 1;
        eventTypeCounts[message.type] = (eventTypeCounts[message.type] || 0) + 1;

        if (message.type === "thread.started") {
          activeSessionId = message.thread_id;
          args.onSession(message.thread_id);
          logThread(args.threadTs, "Codex session initialized", { sessionId: message.thread_id, attempt });
        }

        if (message.type === "item.started" || message.type === "item.updated") {
          itemEventCount += 1;
          itemTypeCounts[message.item.type] = (itemTypeCounts[message.item.type] || 0) + 1;
          if (isPotentiallySideEffectingItem(message.item)) sideEffectEventCount += 1;
          const tool = codexItemToTool(message.item);
          if (tool) {
            runningTools.set(message.item.id, tool);
            args.onTool(tool);
          }
        }

        if (message.type === "item.completed") {
          itemEventCount += 1;
          itemTypeCounts[message.item.type] = (itemTypeCounts[message.item.type] || 0) + 1;
          if (isPotentiallySideEffectingItem(message.item)) sideEffectEventCount += 1;
          if (message.item.type === "agent_message") {
            resultText = message.item.text || resultText;
            if (message.item.text.trim()) args.onAgentMessage?.(message.item.id, message.item.text.trim());
          }
          const tool = codexItemToTool(message.item);
          if (tool) {
            runningTools.delete(message.item.id);
            args.onTool(
              Array.from(runningTools.values()).at(-1) || null,
              tool,
              completedToolStatus(message.item),
            );
          }
        }

        if (message.type === "turn.completed") turnCompleted = true;
        if (message.type === "turn.failed") throw new Error(message.error.message);
        if (message.type === "error") {
          lastStreamError = message.message;
          writeLog("error", {
            scope: "codex-stream",
            threadTs: args.threadTs,
            message: "Codex stream diagnostic; waiting for terminal turn event",
            attempt,
            sessionId: activeSessionId || null,
            streamError: message.message,
            eventCount,
            itemEventCount,
            sideEffectEventCount,
          });
        }
      }

      if (!turnCompleted) {
        throw new Error(lastStreamError || "Codex stream ended before turn.completed");
      }
      return resultText;
    } catch (error) {
      const willRetry = shouldRetryCodexTurn(error, attempt, sideEffectEventCount);
      writeLog("error", {
        scope: "codex-query",
        threadTs: args.threadTs,
        message: willRetry ? "Codex query transport failed; retrying" : "Codex query attempt failed",
        attempt,
        maxAttempts: MAX_CODEX_ATTEMPTS,
        willRetry,
        retryDelayMs: willRetry ? CODEX_RETRY_DELAY_MS : null,
        retrySafety: sideEffectEventCount === 0 ? "no-side-effect-events" : "side-effect-events-observed",
        eventCount,
        itemEventCount,
        sideEffectEventCount,
        eventTypeCounts,
        itemTypeCounts,
        elapsedMs: Date.now() - attemptStartedAt,
        sessionId: activeSessionId || null,
        model: DEFAULT_MODEL,
        reasoningEffort: getModelReasoningEffort() || null,
        cwd: args.cwd,
        runtimeSource: codexPathOverride ? "CODEX_PATH override" : "SDK bundled runtime",
        codexPathOverride: codexPathOverride || null,
        error: serializeError(error),
      });

      if (!willRetry) throw error;
      logThread(args.threadTs, "Retrying Codex query after transport disconnect", {
        attempt: attempt + 1,
        maxAttempts: MAX_CODEX_ATTEMPTS,
        sessionId: activeSessionId || null,
        delayMs: CODEX_RETRY_DELAY_MS,
      });
      await sleep(CODEX_RETRY_DELAY_MS);
    }
  }

  throw new Error("Codex query exhausted retry attempts");
}

async function runClaudeQuery(args: RunAgentArgs): Promise<string> {
  let resultText = "";
  const options: Record<string, unknown> = {
    cwd: args.cwd,
    env: buildClaudeEnv(),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: SYSTEM_PROMPT,
    },
    maxTurns: MAX_TURNS,
    permissionMode: "bypassPermissions",
    stderr: (data: string) => {
      writeLog("error", {
        scope: "claude-stderr",
        threadTs: args.threadTs,
        message: "Claude subprocess stderr",
        data,
      });
    },
  };

  if (CLAUDE_MODEL) options.model = CLAUDE_MODEL;
  if (args.existingSessionId) options.resume = args.existingSessionId;

  for await (const message of query({ prompt: args.prompt.text, options })) {
    if (message.type === "system" && message.subtype === "init") {
      args.onSession(message.session_id);
      logThread(args.threadTs, "Claude session initialized", { sessionId: message.session_id });
    }

    if (message.type === "assistant") {
      const content = message.message?.content || [];
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        args.onTool({
          id: block.id,
          name: block.name,
          detail: formatToolDetail(block.name, block.input as Record<string, unknown>),
        });
      }
    }

    if (message.type === "result" && message.subtype === "success") resultText = message.result || "";
    if (message.type === "result" && message.subtype !== "success") {
      const errorMessage = (message as any).error || (message as any).message || "Unknown error";
      throw new Error(errorMessage);
    }
  }

  return resultText;
}
