import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, readSettings, keyNamesIn } from "../src/settings.ts";

test("no settings file gives the defaults", () => {
  assert.deepEqual(readSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings("broken"), DEFAULT_SETTINGS);
});

test("saved values are kept", () => {
  const saved = { version: 1, disabledProviders: ["grok"], newThread: { policy: "round_robin", max_bot_hops: 5 }, newBotAccess: "ask", terminal: { fontSize: 15, scrollback: 10000 }, preview: { openExternally: ["github.com"] } };
  assert.deepEqual(readSettings(saved), saved);
});

test("values that make no sense fall back one by one", () => {
  const read = readSettings({ disabledProviders: ["codex", 4], newThread: { policy: "loudest", max_bot_hops: 99 }, newBotAccess: "root", terminal: { fontSize: 3, scrollback: 123 } });
  assert.deepEqual(read.disabledProviders, ["codex"]);
  assert.equal(read.newThread.policy, "mention");
  assert.equal(read.newThread.max_bot_hops, 10);
  assert.equal(read.newBotAccess, "read");
  assert.equal(read.terminal.fontSize, 10);
  assert.equal(read.terminal.scrollback, 5000);
});

test("the provider list older versions kept in the session file is carried over once", () => {
  assert.deepEqual(readSettings(null, ["aider"]).disabledProviders, ["aider"]);
  // A settings file, once saved, wins over the old copy.
  assert.deepEqual(readSettings({ disabledProviders: [] }, ["aider"]).disabledProviders, []);
});

test("key names are collected from saved agents, once each and sorted", () => {
  const api = (env) => ({ backend: { kind: "open_ai_compatible", base_url: "", model: "", api_key_env: env } });
  const names = keyNamesIn([api("OPENROUTER_API_KEY"), api("ANTHROPIC_API_KEY"), api("OPENROUTER_API_KEY"), api(null), api("  "), { backend: { kind: "scripted" } }]);
  assert.deepEqual(names, [{ name: "ANTHROPIC_API_KEY", uses: 1 }, { name: "OPENROUTER_API_KEY", uses: 2 }]);
});

test("hosts to open in the browser are kept lower case, once each", () => {
  assert.deepEqual(readSettings({ preview: { openExternally: ["GitHub.com", "github.com", 4, " "] } }).preview.openExternally, ["github.com"]);
  assert.deepEqual(readSettings({ preview: "broken" }).preview.openExternally, []);
});
