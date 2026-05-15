#!/bin/zsh

# Crash-recovery wrapper: runs the bot in a loop, restarting on non-zero exit.
# - Exit code 0 (clean shutdown / intentional kill) → stop looping
# - Exit code non-zero (crash) → wait and restart
#
# Writes its own PID to .data/wrapper.pid so restart-bot.sh can stop it.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$ROOT_DIR/.data"
WRAPPER_PID_FILE="$DATA_DIR/wrapper.pid"
RESTART_LOG="$DATA_DIR/restart.log"
RESTART_DELAY=3

mkdir -p "$DATA_DIR"

log() {
  printf '%s %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*" >> "$RESTART_LOG"
}

# Write wrapper PID so restart-bot.sh can kill us
echo $$ > "$WRAPPER_PID_FILE"

# On SIGTERM, kill child and exit cleanly (no restart)
CHILD_PID=""
cleanup() {
  log "Wrapper received SIGTERM, shutting down"
  if [[ -n "$CHILD_PID" ]] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill "$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
  fi
  rm -f "$WRAPPER_PID_FILE"
  exit 0
}
trap cleanup SIGTERM SIGINT

log "Wrapper started pid=$$"

while true; do
  "$ROOT_DIR/node_modules/.bin/tsx" "$ROOT_DIR/src/index.ts" &
  CHILD_PID=$!

  wait "$CHILD_PID" 2>/dev/null
  EXIT_CODE=$?
  CHILD_PID=""

  if [[ $EXIT_CODE -eq 0 ]]; then
    log "Bot exited cleanly (code 0), not restarting"
    break
  fi

  log "Bot crashed with exit code $EXIT_CODE, restarting in ${RESTART_DELAY}s"
  sleep "$RESTART_DELAY"
done

rm -f "$WRAPPER_PID_FILE"
