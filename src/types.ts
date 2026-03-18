export type LogLevel = "info" | "error";

export type LogPayload = {
  scope?: string;
  threadTs?: string | null;
  message: string;
  [key: string]: unknown;
};

export type ActiveQuery = {
  threadTs: string;
  user?: string;
  channel?: string;
  text?: string;
  cwd?: string;
  sessionId?: string | null;
  startedAt?: string;
  thinkingTs?: string | null;
  phase?: string;
  currentTool?: { name: string; detail: string };
  completedTools?: Array<{ name: string; detail: string }>;
  lastProgressAt?: string;
  interruptedAt?: string;
  reason?: string;
  status?: string;
  detail?: string;
};

export type SlackFile = {
  id: string;
  name?: string;
  mimetype?: string;
  url_private?: string;
  filetype?: string;
};

export type BotEvent = {
  thread_ts?: string;
  ts: string;
  text: string;
  user: string;
  channel: string;
  channel_type?: string;
  bot_id?: string;
  subtype?: string;
  files?: SlackFile[];
};

export type SayArgs = {
  text: string;
  thread_ts: string;
  blocks?: unknown[];
};

export type SayResult = { ts: string };
export type SayFn = (args: SayArgs) => Promise<SayResult>;
