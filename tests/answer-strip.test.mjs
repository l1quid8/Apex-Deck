import test from "node:test";
import assert from "node:assert/strict";
import { editCounts, listRows, nextLine, nextStripPane, sizeText, stripView } from "../src/answerStrip.ts";

const card = (request, action, at = 1) => ({ room: "t", participant: "null", request, action, at });
const run = (detail) => ({ kind: "command", title: "Run a command", detail });
const added = (n) => Array.from({ length: n }, (_, i) => `+line ${i}`).join("\n") + "\n";
const edit = (detail, title = "Edit src/auth/session.ts") => ({ kind: "edit", title, detail });

test("a command is answered in place, with the whole command shown", () => {
  assert.deepEqual(stripView(run("npm test -- --run auth")), { kind: "command", label: "Wants to run a command", command: "npm test -- --run auth" });
});

test("a small edit is answered in place with its size, file and whole diff", () => {
  const detail = "--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -1,3 +1,9 @@\n" + added(8) + "-old one\n-old two\n";
  assert.deepEqual(editCounts(detail), { added: 8, removed: 2 });
  assert.deepEqual(stripView(edit(detail)), { kind: "edit", label: "Wants to change a file", summary: "+8 −2 · src/auth/session.ts", diff: detail });
  assert.equal(stripView(edit(added(20))).kind, "edit", "20 changed lines is still small");
  assert.equal(stripView(edit("a.rs\n-x\n+y\n", "Edit a.rs")).summary, "+1 −1 · a.rs", "Codex puts the path first");
  assert.equal(stripView(edit("+hi\n", "Write hello.txt")).summary, "+1 −0 · hello.txt");
});

test("larger edits, tool calls and permission questions open the thread", () => {
  assert.deepEqual(stripView(edit(added(21))), { kind: "open", label: "Wants to change a file" });
  assert.deepEqual(stripView({ kind: "tool", title: "x-mcp: post_tweet", detail: "{}" }), { kind: "open", label: "Wants to call an MCP tool" });
  assert.deepEqual(stripView({ kind: "other", title: "node_repl asks permission", detail: "Allow?" }), { kind: "open", label: "Wants permission" });
});

test("a card whose content wasn't reported is never answered blind", () => {
  assert.equal(stripView(edit("The edit was not described.", "Edit files")).kind, "open");
  assert.equal(stripView(edit("")).kind, "open");
  assert.equal(stripView(run("")).kind, "open");
  assert.equal(stripView(run("   \n")).kind, "open");
  assert.equal(stripView(run("(command not given)")).kind, "open");
});

test("the strip names the thread's next card", () => {
  const first = card("ask-1", run("npm test"));
  assert.equal(nextLine([first]), null);
  assert.equal(nextLine([first, card("ask-2", edit("-a\n-b\n" + added(8)))]), "Next in this thread: Edit src/auth/session.ts · +8 −2");
  assert.equal(nextLine([first, card("ask-2", run("cargo build\n\nneeds network"))]), "Next in this thread: Run cargo build");
  assert.equal(nextLine([first, card("ask-2", { kind: "tool", title: "x-mcp: post_tweet", detail: "{}" })]), "Next in this thread: x-mcp: post_tweet");
  assert.equal(sizeText("+a\n-b\n"), "+1 −1");
});

test("rows answered from the list stay in place until it closes", () => {
  const signal = (kind, at) => ({ kind, note: "", at });
  const fix = { paneId: "fix", signal: signal("needs_input", 100) };
  const notes = { paneId: "notes", signal: signal("needs_input", 50) };
  const ready = { paneId: "code", signal: signal("done", 300) };
  assert.deepEqual(listRows([ready, notes, fix], []).map((r) => r.paneId), ["fix", "notes", "code"], "most urgent first, newest first");
  assert.deepEqual(listRows([ready, notes], [fix]).map((r) => r.paneId), ["fix", "notes", "code"], "an answered row keeps its place");
  const live = { ...fix, cards: [] };
  assert.equal(listRows([live], [fix])[0], live, "the live row wins over the remembered one");
  assert.equal(listRows([live], [fix]).length, 1);
});

test("after an answer, focus goes to the next card", () => {
  const rows = [
    { paneId: "fix", cards: [card("ask-2", run("ls"))] },
    { paneId: "notes", cards: [] },
    { paneId: "site", cards: [card("ask-1", run("ls"))] },
  ];
  assert.equal(nextStripPane(rows, "fix"), "fix", "its own next card first");
  assert.equal(nextStripPane([{ paneId: "fix", cards: [] }, rows[1], rows[2]], "fix"), "site", "then the next thread with cards");
  assert.equal(nextStripPane([rows[2], rows[1], { paneId: "fix", cards: [] }], "fix"), "site", "wrapping round");
  assert.equal(nextStripPane([{ paneId: "fix" }, rows[1]], "fix"), "fix", "none left: its own strip, which says so");
  assert.equal(nextStripPane([], "gone"), "gone");
});
