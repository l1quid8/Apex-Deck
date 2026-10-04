import test from "node:test";
import assert from "node:assert/strict";
import { closeNeedsConfirm, closeQuestion, loadedThreads, openPanes, savedThreads } from "../src/closing.ts";

const chat = (id, extra = {}) => ({ id, workspaceId: "w", kind: "chat", title: id, ...extra });
const term = (id, extra = {}) => ({ id, workspaceId: "w", kind: "terminal", title: id, ...extra });

test("only a busy or waiting terminal asks before closing", () => {
  assert.equal(closeNeedsConfirm("terminal", "working"), true);
  assert.equal(closeNeedsConfirm("terminal", "needs_input"), true);
  for (const status of ["idle", "exited", "done", "failed"]) assert.equal(closeNeedsConfirm("terminal", status), false, status);
  for (const status of ["working", "needs_input", "idle"]) assert.equal(closeNeedsConfirm("chat", status), false, status);
});

test("the question says whether the terminal is working or waiting", () => {
  assert.equal(closeQuestion("Codex", "working").title, "Codex is still working.");
  assert.equal(closeQuestion("Codex", "needs_input").title, "Codex is waiting for you.");
  assert.equal(closeQuestion("Codex", "working").action, "End and close");
});

test("closed threads and threads being deleted are off the deck", () => {
  const panes = [chat("a"), chat("b", { closed: true }), chat("c"), term("t")];
  assert.deepEqual(openPanes(panes, new Set(["c"])).map((p) => p.id), ["a", "t"]);
});

test("a thread waiting out its undo time is still saved, so quitting keeps it", () => {
  const panes = [chat("a"), chat("gone-soon"), term("t")];
  // The deck hides "gone-soon", but the session file must still hold it.
  assert.deepEqual(savedThreads(panes).map((p) => p.id), ["a", "gone-soon"]);
});

test("a closed thread stays saved", () => {
  assert.deepEqual(savedThreads([chat("a", { closed: true })]).map((p) => p.closed), [true]);
});

test("an older session file without the closed field opens every thread", () => {
  const saved = [chat("a"), chat("b"), chat("other", { workspaceId: "gone" }), term("t"), null];
  const loaded = loadedThreads(saved, ["w"]);
  assert.deepEqual(loaded.map((p) => p.id), ["a", "b"]);
  assert.ok(loaded.every((p) => p.closed === false));
  assert.deepEqual(openPanes(loaded, new Set()).map((p) => p.id), ["a", "b"]);
});

test("a thread saved as closed stays closed", () => {
  assert.equal(loadedThreads([chat("a", { closed: true })], ["w"])[0].closed, true);
});
