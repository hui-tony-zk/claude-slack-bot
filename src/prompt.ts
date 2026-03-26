import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "./config.js";

function loadFile(filename: string): string {
  try {
    return readFileSync(join(PATHS.ROOT_DIR, filename), "utf-8").trim();
  } catch {
    return "";
  }
}

function loadAppend(): string {
  const botPrompt = loadFile("bot_prompt.txt");   // versioned — bot features
  const userPrompt = loadFile("system_prompt.txt"); // gitignored — personal config
  const parts = [botPrompt, userPrompt].filter(Boolean);
  return parts.join("\n\n") || "You are a coding assistant running on a local machine via a Slack bot.";
}

export const SYSTEM_PROMPT = {
  type: "preset",
  preset: "claude_code",
  append: loadAppend(),
} as const;
