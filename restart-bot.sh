#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$ROOT_DIR/.data"
PID_FILE="$DATA_DIR/bot.pid"
RESTART_LOG="$DATA_DIR/restart.log"

mkdir -p "$DATA_DIR"

log() {
  printf '%s %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*" >> "$RESTART_LOG"
}

stop_existing_bot() {
  if [[ ! -f "$PID_FILE" ]]; then
    return
  fi

  local pid
  pid="$(<"$PID_FILE")"

  if [[ -z "$pid" ]]; then
    return
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    return
  fi

  log "Stopping existing bot pid=$pid"
  kill "$pid" 2>/dev/null || true

  for _ in {1..50}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      return
    fi
    sleep 0.2
  done

  log "Force killing unresponsive bot pid=$pid"
  kill -9 "$pid" 2>/dev/null || true
  sleep 0.2

  # Clean up stale PID file after process is confirmed dead
  rm -f "$PID_FILE"
}

start_bot() {
  log "Starting bot"
  local spawned_pid
  spawned_pid="$(
    node - "$ROOT_DIR" "$RESTART_LOG" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const rootDir = process.argv[2];
const restartLog = process.argv[3];
const stderrFd = fs.openSync(restartLog, "a");
const child = spawn(path.join(rootDir, "node_modules", ".bin", "tsx"), [path.join(rootDir, "src", "index.ts")], {
  cwd: rootDir,
  detached: true,
  stdio: ["ignore", "ignore", stderrFd],
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== "CLAUDECODE" && !key.startsWith("CLAUDE_CODE_")
    )
  ),
});

child.unref();
console.log(child.pid);
NODE
  )"

  log "Spawned bot pid=$spawned_pid"

  for _ in {1..100}; do
    if [[ -f "$PID_FILE" ]]; then
      local locked_pid
      locked_pid="$(<"$PID_FILE")"
      if [[ -n "$locked_pid" ]] && kill -0 "$locked_pid" 2>/dev/null; then
        echo "$locked_pid"
        return
      fi
    fi

    if ! kill -0 "$spawned_pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done

  log "Bot failed to acquire lock or stay running pid=$spawned_pid"
  return 1
}

stop_existing_bot
start_bot
