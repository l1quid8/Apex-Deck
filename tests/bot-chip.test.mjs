import test from "node:test";
import assert from "node:assert/strict";
import { chipDescription, levelsShown, loadFolded, saveFolded } from "../src/botChip.ts";

const all = { tool: true, effort: true, usage: true };
const claude = { id: "jigga", display_name: "Jigga", persona: "", access: "ask", effort: "high", backend: { kind: "agent", tool: "claude_code", model: "opus-4.5" } };

test("a chip describes the bot as before when every part is shown", () => {
  assert.equal(chipDescription(claude, all), "Claude Code · opus-4.5 · high · asks first");
  assert.equal(chipDescription({ ...claude, backend: { kind: "open_ai_compatible", model: "llama3" }, access: "read" }, all), "API · llama3 · high");
  assert.equal(chipDescription({ ...claude, backend: { kind: "agent", tool: "codex", model: null }, effort: null, access: "full" }, all), "Codex · default model");
  assert.equal(chipDescription({ ...claude, backend: { kind: "cli", program: "aider" } }, all), "Command · aider");
  assert.equal(chipDescription({ ...claude, backend: { kind: "scripted", lines: [] } }, all), "Scripted");
});

test("the tool name and effort can be left out; the model and asks first always stay", () => {
  assert.equal(chipDescription(claude, { ...all, tool: false }), "opus-4.5 · high · asks first");
  assert.equal(chipDescription(claude, { ...all, effort: false }), "Claude Code · opus-4.5 · asks first");
  assert.equal(chipDescription(claude, { tool: false, effort: false, usage: true }), "opus-4.5 · asks first");
  assert.equal(chipDescription({ ...claude, backend: { kind: "open_ai_compatible", model: "llama3" } }, { ...all, tool: false }), "llama3 · high", "API bots never said asks first");
});

test("hidden usage still shows a level that runs low", () => {
  const low = (n) => n !== null && n < 0.15;
  assert.deepEqual(levelsShown({ context: 0.8, plan: 0.6 }, all, low), { context: 0.8, plan: 0.6 });
  assert.deepEqual(levelsShown({ context: 0.8, plan: 0.6 }, { ...all, usage: false }, low), { context: null, plan: null });
  assert.deepEqual(levelsShown({ context: 0.1, plan: 0.6 }, { ...all, usage: false }, low), { context: 0.1, plan: null });
});

test("folding is remembered per thread", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  assert.equal(loadFolded("a"), false);
  saveFolded("a", true);
  assert.equal(loadFolded("a"), true);
  assert.equal(loadFolded("b"), false, "another thread is not folded");
  saveFolded("a", false);
  assert.equal(loadFolded("a"), false);
  delete globalThis.localStorage;
  assert.equal(loadFolded("a"), false, "no storage: unfolded");
});
