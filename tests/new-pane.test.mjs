import test from "node:test";
import assert from "node:assert/strict";
import { detailsThread, noteFocus } from "../src/detailsLayout.ts";
import { newMenuItems } from "../src/newPaneItems.ts";
import { nameForModel, uniqueName } from "../src/quickAdd.ts";
import { slug } from "../src/slug.ts";
const on = (disabled) => (key) => !disabled.includes(key);

test("thread details follow the focused thread, then the last one looked at, then the first on screen", () => {
  assert.equal(detailsThread("b", ["a", "b"], []), "b");
  // A terminal is focused: show the thread looked at most recently that is still on screen.
  assert.equal(detailsThread("term", ["a", "b"], ["gone", "b", "a"]), "b");
  assert.equal(detailsThread(null, ["a", "b"], []), "a");
  assert.equal(detailsThread("a", [], ["a"]), null);
});

test("focus history keeps the most recent first, once each", () => {
  assert.deepEqual(noteFocus(["a", "b", "c"], "b"), ["b", "a", "c"]);
  assert.deepEqual(noteFocus([], "a"), ["a"]);
  assert.equal(noteFocus(Array.from({ length: 30 }, (_, i) => `p${i}`), "x").length, 20);
});

const agents = [
  { key: "claude", label: "Claude Code", program: "claude", found: true },
  { key: "gemini", label: "Gemini CLI", program: "gemini", found: false },
  { key: "codex", label: "Codex", program: "codex", found: true },
];

test("the + New menu lists installed tools first, then the shell, then missing tools", () => {
  const items = newMenuItems("code", agents, on([]), "");
  assert.deepEqual(items.map((i) => i.label), ["Claude Code", "Codex", "Terminal", "Gemini CLI"]);
  assert.equal(items.at(-1).installed, false);
  assert.equal(items.at(-1).detail, "not installed");
  assert.deepEqual(newMenuItems("threads", agents, on([]), "").map((i) => i.kind), ["chat"]);
  assert.deepEqual(newMenuItems("agents", agents, on([]), ""), []);
});

test("the + New menu filters by name or program and leaves out hidden providers", () => {
  assert.deepEqual(newMenuItems("code", agents, on([]), "codex").map((i) => i.key), ["codex"]);
  assert.deepEqual(newMenuItems("code", agents, on([]), "cod").map((i) => i.key), ["claude", "codex"]);
  assert.deepEqual(newMenuItems("code", agents, on([]), "shell").map((i) => i.key), ["shell"]);
  assert.deepEqual(newMenuItems("code", agents, on([]), "zzz"), []);
  assert.ok(!newMenuItems("code", agents, on(["codex"]), "").some((i) => i.key === "codex"));
});

test("a new bot is named from its model", () => {
  assert.equal(nameForModel("claude_code", "Claude Code", "opus"), "Opus");
  assert.equal(nameForModel("claude_code", "Claude Code", "claude-sonnet-5-5"), "Sonnet");
  assert.equal(nameForModel("claude_code", "Claude Code", ""), "Claude");
  assert.equal(nameForModel("codex", "Codex", "gpt-5.5"), "Codex");
  assert.equal(nameForModel("ollama", "Ollama (local models)", "llama3:8b"), "Llama3");
  assert.equal(nameForModel("ollama", "Ollama (local models)", ""), "Ollama");
});

test("a name already in the chat gets a number", () => {
  assert.equal(uniqueName("Opus", [], slug), "Opus");
  assert.equal(uniqueName("Opus", ["opus"], slug), "Opus 2");
  assert.equal(uniqueName("Opus", ["opus", "opus-2"], slug), "Opus 3");
});
