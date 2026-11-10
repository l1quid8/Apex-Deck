import test from "node:test";
import assert from "node:assert/strict";
import { deleteThreadGate, deleteThreadWords, removeThreadFrom } from "../src/phone/threadDelete.ts";

function session(over = {}) {
  return {
    version: 1,
    workspaces: [{ id: "a", name: "Project a", path: "/work/a" }],
    panes: [
      { id: "t1", workspaceId: "a", kind: "chat", title: "One" },
      { id: "t2", workspaceId: "a", kind: "chat", title: "Two" },
    ],
    profiles: [],
    activeWorkspace: "a",
    focusedPane: "t2",
    section: "threads",
    ...over,
  };
}

test("the question says the thread is deleted on the machine, with no undo", () => {
  const asked = deleteThreadWords("Weekly review");
  assert.equal(asked.title, "Delete Weekly review?");
  assert.equal(asked.action, "Delete thread");
  assert.match(asked.body, /removed from the machine/);
  assert.match(asked.body, /no undo/);
});

test("deleting needs a paired, online machine with Full access", () => {
  assert.equal(deleteThreadGate({ paired: true, online: true, full: true, machine: "Studio" }), "");
  assert.match(deleteThreadGate({ paired: false, online: true, full: true, machine: "Studio" }), /isn't paired/);
  assert.match(deleteThreadGate({ paired: true, online: false, full: true, machine: "Studio" }), /^Connect Studio before deleting this thread\.$/);
  assert.match(deleteThreadGate({ paired: true, online: true, full: false, machine: "Studio" }), /Full access on Studio/);
});

test("the thread leaves the list and the focused thread is let go", () => {
  const next = removeThreadFrom(session(), "t2");
  assert.deepEqual(next.panes.map((pane) => pane.id), ["t1"]);
  assert.equal(next.focusedPane, null);
});

test("another thread's focus is left alone", () => {
  assert.equal(removeThreadFrom(session(), "t1").focusedPane, "t2");
});

test("an id that isn't there changes nothing, so deleting twice is harmless", () => {
  const once = removeThreadFrom(session(), "t1");
  const twice = removeThreadFrom(once, "t1");
  assert.equal(twice, once);
  assert.deepEqual(twice.panes.map((pane) => pane.id), ["t2"]);
});

test("a terminal in the list is not a thread, and deleting the thread keeps the workspace", () => {
  const withTerminal = session({ panes: [{ id: "term", workspaceId: "a", kind: "terminal", title: "shell" }, { id: "t1", workspaceId: "a", kind: "chat", title: "One" }], focusedPane: null });
  const next = removeThreadFrom(withTerminal, "t1");
  assert.deepEqual(next.panes.map((pane) => pane.id), ["term"]);
  assert.deepEqual(next.workspaces.map((workspace) => workspace.id), ["a"]);
});
