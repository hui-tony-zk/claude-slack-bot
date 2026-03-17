import "dotenv/config";
import bolt from "@slack/bolt";
import { DEFAULT_CWD } from "./config.js";
import { createMessageHandler } from "./handler.js";
import { removeLegacyRuntimeLog, writeLog } from "./logger.js";
import { createStateStore } from "./state.js";

const { App } = bolt;
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const state = createStateStore();
const handleMessage = createMessageHandler(app as any, state);

app.event("app_mention", (args: any) => {
  writeLog("info", {
    scope: "event",
    threadTs: args.event.thread_ts || args.event.ts,
    message: "Received app_mention event",
    user: args.event.user,
  });
  return handleMessage(args);
});

app.event("message", async (args: any) => {
  const { event } = args;
  writeLog("info", {
    scope: "event",
    threadTs: event.thread_ts || event.ts,
    message: "Received message event",
    channelType: event.channel_type,
    botId: event.bot_id || null,
    subtype: event.subtype || null,
  });
  if (event.channel_type !== "im" || event.bot_id || event.subtype) return;
  await handleMessage(args);
});

process.on("exit", () => state.releaseProcessLock());
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

process.on("unhandledRejection", (err) => {
  writeLog("error", {
    scope: "process",
    message: "Unhandled rejection",
    error: (err as Error)?.message || String(err),
    stack: (err as Error)?.stack || null,
  });
});

process.on("uncaughtException", (err) => {
  writeLog("error", {
    scope: "process",
    message: "Uncaught exception",
    error: err.message,
    stack: err.stack || null,
  });
});

async function main(): Promise<void> {
  removeLegacyRuntimeLog();
  state.markRecoveredQueriesAsInterrupted();
  state.acquireProcessLock();
  await app.start();
  writeLog("info", {
    scope: "startup",
    message: "Claude Slack bot started",
    defaultCwd: DEFAULT_CWD,
  });
}

main();
