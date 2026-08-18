import assert from "node:assert/strict";
import test from "node:test";
import { shouldRetryCodexTurn } from "./agents.js";
import { serializeError } from "./logger.js";

const disconnect = new Error(
  "stream disconnected before completion: websocket closed by server before response.completed",
);

test("retries a first-attempt Codex disconnect when no side-effect events were emitted", () => {
  assert.equal(shouldRetryCodexTurn(disconnect, 1, 0), true);
});

test("does not retry after a command, file change, or MCP event may have had side effects", () => {
  assert.equal(shouldRetryCodexTurn(disconnect, 1, 1), false);
});

test("does not retry the final attempt or unrelated failures", () => {
  assert.equal(shouldRetryCodexTurn(disconnect, 2, 0), false);
  assert.equal(shouldRetryCodexTurn(new Error("rate limit exceeded"), 1, 0), false);
});

test("verbose error diagnostics include causes and redact credentials", () => {
  const cause = Object.assign(new Error("socket closed"), {
    code: "ECONNRESET",
    stderr: "Authorization: Bearer secret-token-value",
  });
  const serialized = serializeError(new Error("Codex failed", { cause }));

  assert.equal(serialized.name, "Error");
  assert.match(String(serialized.stack), /Codex failed/);
  assert.deepEqual(serialized.cause, {
    name: "Error",
    message: "socket closed",
    stack: (serialized.cause as Record<string, unknown>).stack,
    code: "ECONNRESET",
    stderr: "Authorization: [REDACTED]",
  });
});
