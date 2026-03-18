function markdownToSlack(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
}

export function formatToolDetail(name: string, input: Record<string, unknown> = {}): string {
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return typeof input.file_path === "string" ? input.file_path.split("/").pop() || "file" : "file";
    case "Bash": {
      const cmd = typeof input.command === "string" ? input.command : "";
      return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    }
    case "Grep":
      return typeof input.pattern === "string" ? `/${input.pattern}/` : "pattern";
    case "Glob":
      return typeof input.pattern === "string" ? input.pattern : "pattern";
    case "Agent":
      return typeof input.description === "string" ? input.description : "sub-task";
    case "WebFetch":
      return "fetching page";
    case "WebSearch":
      return typeof input.query === "string" ? input.query : "searching";
    default:
      return "";
  }
}

function collapseTools(
  tools: Array<{ name: string; detail: string }>
): Array<{ name: string; details: string[] }> {
  const collapsed: Array<{ name: string; details: string[] }> = [];
  for (const tool of tools) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.name === tool.name) {
      if (tool.detail) last.details.push(tool.detail);
    } else {
      collapsed.push({ name: tool.name, details: tool.detail ? [tool.detail] : [] });
    }
  }
  return collapsed;
}

function formatElapsedMs(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

function formatElapsed(startTime: number): string {
  return formatElapsedMs(Date.now() - startTime);
}

function toolLines(
  tools: Array<{ name: string; detail: string }>,
  currentTool?: { name: string; detail: string } | null
): string[] {
  const lines: string[] = [];
  for (const group of collapseTools(tools.slice(-10))) {
    const detail = group.details.length ? ` ${group.details.join(", ")}` : "";
    lines.push(`${group.name}${detail}`);
  }
  if (currentTool) {
    lines.push(`${currentTool.name}${currentTool.detail ? ` ${currentTool.detail}` : ""}...`);
  }
  return lines;
}

export function buildProgressBlocks(
  completedTools: Array<{ name: string; detail: string }>,
  currentTool: { name: string; detail: string } | null,
  startTime?: number
): unknown[] {
  const elapsed = startTime ? formatElapsed(startTime) : "";
  const elements: unknown[] = [
    { type: "mrkdwn", text: `Working on it... ${elapsed}` },
  ];
  const lines = toolLines(completedTools, currentTool);
  for (const line of lines) {
    elements.push({ type: "mrkdwn", text: line });
  }
  return [{ type: "context", elements }];
}

export function buildCompletedTraceBlocks(
  completedTools: Array<{ name: string; detail: string }>,
  elapsedMs: number
): unknown[] {
  const elapsed = formatElapsedMs(elapsedMs);
  const elements: unknown[] = [
    { type: "mrkdwn", text: `Done (${elapsed})` },
  ];
  for (const line of toolLines(completedTools)) {
    elements.push({ type: "mrkdwn", text: line });
  }
  return [{ type: "context", elements }];
}

export function formatResultBlocks(text: string): unknown[] {
  if (!text) return [{ type: "section", text: { type: "mrkdwn", text: "(no output)" } }];

  const converted = markdownToSlack(text);
  const maxLen = 3000;
  const blocks: unknown[] = [];
  let remaining = converted;

  while (remaining.length > 0) {
    let chunk: string;
    if (remaining.length <= maxLen) {
      chunk = remaining;
      remaining = "";
    } else {
      const splitAt = remaining.lastIndexOf("\n", maxLen);
      if (splitAt > 0) {
        chunk = remaining.slice(0, splitAt);
        remaining = remaining.slice(splitAt + 1);
      } else {
        chunk = remaining.slice(0, maxLen);
        remaining = remaining.slice(maxLen);
      }
    }
    if (chunk.trim()) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
    }
  }

  if (blocks.length > 50) {
    blocks.length = 49;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_...response truncated_" } });
  }

  return blocks.length ? blocks : [{ type: "section", text: { type: "mrkdwn", text: "(no output)" } }];
}
