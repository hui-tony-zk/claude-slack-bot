import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "./config.js";

const DEFAULT_APPEND = `You are a coding assistant running on a local machine via a Slack bot.
You have full filesystem access and can read, write, edit files, and run commands.
Keep responses concise — this is Slack, not an IDE.

When asked about a project, cd into it and read its CLAUDE.md for conventions.

Your own source code is in the claude-slack-bot directory.
You can read and edit it to improve yourself.`;

function loadAppend(): string {
  const promptPath = join(PATHS.ROOT_DIR, "system_prompt.txt");
  try {
    return readFileSync(promptPath, "utf-8").trim();
  } catch {
    return DEFAULT_APPEND;
  }
}

export const SYSTEM_PROMPT = {
  type: "preset",
  preset: "claude_code",
  append: loadAppend(),
} as const;
