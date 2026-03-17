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

export function buildProgressBlocks(
  completedTools: Array<{ name: string; detail: string }>,
  currentTool: { name: string; detail: string } | null
): unknown[] {
  const lines = [":hourglass_flowing_sand: *Working on it...*"];
  if (completedTools.length || currentTool) lines.push("");
  for (const tool of completedTools.slice(-10)) {
    lines.push(`:white_check_mark: ${tool.name}${tool.detail ? ` \`${tool.detail}\`` : ""}`);
  }
  if (currentTool) {
    lines.push(`:gear: ${currentTool.name}${currentTool.detail ? ` \`${currentTool.detail}\`` : ""}...`);
  }
  return [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }];
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
