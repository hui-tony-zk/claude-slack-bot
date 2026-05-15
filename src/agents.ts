import { query } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";
import type { ApprovalMode, Input, ModelReasoningEffort, SandboxMode, ThreadItem } from "@openai/codex-sdk";
import { CLAUDE_MODEL, CODEX_MODEL_REASONING_EFFORT, DEFAULT_MODEL, MAX_TURNS } from "./config.js";
import { formatToolDetail } from "./formatting.js";
import { logThread, writeLog } from "./logger.js";
import { SYSTEM_PROMPT } from "./prompt.js";

export type AgentProvider = "codex" | "claude";

export type BuiltPrompt = {
  text: string;
  imagePaths: string[];
};

export type ToolTrace = { name: string; detail: string };

type RunAgentArgs = {
  prompt: BuiltPrompt;
  cwd: string;
  existingSessionId: string | undefined;
  threadTs: string;
  onSession: (sessionId: string) => void;
  onTool: (tool: ToolTrace | null, completedTool?: ToolTrace) => void;
};

const CODEX_SESSION_PREFIX = "codex:";
const CLAUDE_SESSION_PREFIX = "claude:";
const VALID_SANDBOX_MODES = new Set<SandboxMode>(["read-only", "workspace-write", "danger-full-access"]);
const VALID_APPROVAL_MODES = new Set<ApprovalMode>(["never", "on-request", "on-failure", "untrusted"]);
const VALID_REASONING_EFFORTS = new Set<ModelReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);

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

function codexItemToTool(item: ThreadItem): ToolTrace | null {
  switch (item.type) {
    case "command_execution":
      return { name: "Bash", detail: item.command };
    case "file_change": {
      const paths = item.changes.map((change) => change.path.split("/").pop() || change.path);
      return { name: "Patch", detail: paths.slice(0, 3).join(", ") };
    }
    case "mcp_tool_call":
      return { name: `${item.server}:${item.tool}`, detail: formatToolDetail(item.tool, item.arguments as Record<string, unknown>) };
    case "web_search":
      return { name: "WebSearch", detail: item.query };
    case "todo_list": {
      const completed = item.items.filter((todo) => todo.completed).length;
      return { name: "Todo", detail: `${completed}/${item.items.length}` };
    }
    case "error":
      return { name: "Error", detail: item.message };
    default:
      return null;
  }
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
  let resultText = "";
  const codex = new Codex();
  const threadOptions = {
    model: DEFAULT_MODEL,
    workingDirectory: args.cwd,
    sandboxMode: getSandboxMode(),
    approvalPolicy: getApprovalPolicy(),
    skipGitRepoCheck: true,
    modelReasoningEffort: getModelReasoningEffort(),
  };
  const thread = args.existingSessionId
    ? codex.resumeThread(args.existingSessionId, threadOptions)
    : codex.startThread(threadOptions);
  const { events } = await thread.runStreamed(buildCodexInput(args.prompt));
  const runningTools = new Map<string, ToolTrace>();

  for await (const message of events) {
    if (message.type === "thread.started") {
      args.onSession(message.thread_id);
      logThread(args.threadTs, "Codex session initialized", { sessionId: message.thread_id });
    }

    if (message.type === "item.started" || message.type === "item.updated") {
      const tool = codexItemToTool(message.item);
      if (tool) {
        runningTools.set(message.item.id, tool);
        args.onTool(tool);
      }
    }

    if (message.type === "item.completed") {
      if (message.item.type === "agent_message") resultText = message.item.text || resultText;
      const tool = codexItemToTool(message.item);
      if (tool) {
        runningTools.delete(message.item.id);
        args.onTool(Array.from(runningTools.values()).at(-1) || null, tool);
      }
    }

    if (message.type === "turn.failed") throw new Error(message.error.message);
    if (message.type === "error") throw new Error(message.message);
  }

  return resultText;
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
