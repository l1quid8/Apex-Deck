import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const client = readFileSync("src/voice/realtimeClient.ts", "utf8");
const controller = readFileSync("src/voice/realtimeController.ts", "utf8");
const daemon = readFileSync("crates/apex-daemon/src/voice/realtime.rs", "utf8");

test("realtimeClient uses GA output_modalities audio only and session.type realtime", () => {
  // No legacy modalities
  assert.ok(!client.includes('["audio","text"]'), "should not contain legacy [audio,text]");
  assert.match(client, /output_modalities:\s*\[\"audio\"\]/, "should use [audio]");
  // session.update includes type realtime
  assert.match(client, /session:\s*\{\s*type:\s*"realtime"/, "session.update must include type realtime");
  assert.match(controller, /type:\s*"realtime"/, "controller switch must include type realtime");
});

test("realtimeClient ignores incomplete function_call args", () => {
  // Should ignore added, only done
  assert.ok(client.includes('response.output_item.done'), "handles done");
  assert.ok(!client.match(/type === "response\.output_item\.added"/), "must not dispatch on added");
  // Dispatch validates non-empty request
  assert.ok(client.includes('if (!req) return;'), "ignores empty request");
  assert.ok(client.includes('if (!argsStr || argsStr.trim() === "" || argsStr.trim() === "{}")'), "ignores empty argsStr");
});

test("realtime stale startup abort handling", () => {
  assert.ok(controller.includes("AbortController"), "controller uses AbortController");
  assert.ok(controller.includes("thisMicStream"), "captures per-call mic stream");
  assert.ok(client.includes("signal?.aborted"), "client checks signal.aborted");
  assert.ok(client.includes("signal: signal ?? undefined"), "fetch uses signal");
});

test("daemon mints via GA client_secrets and sanitizes errors", () => {
  assert.ok(daemon.includes("client_secrets"), "GA endpoint");
  assert.ok(daemon.includes("value"), "reads GA value");
  assert.ok(!daemon.includes("response.text") || daemon.includes("Realtime error"), "sanitized errors, no body echo");
  // No secret echo in errors - check 401 message
  assert.match(daemon, /key rejected/i, "401 message without echoing body");
});
