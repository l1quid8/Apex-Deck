import test from "node:test";
import assert from "node:assert/strict";
import { removeProjectFrom, removeProjectWords, restoreProjectTo } from "../src/phone/projectRemoval.ts";

const ws = (id) => ({ id, name: `Project ${id}`, path: `/work/${id}` });
const pane = (id, workspaceId, kind = "chat", extra = {}) => ({ id, workspaceId, kind, title: id, ...extra });

function session(over = {}) {
  return {
    version: 1,
    workspaces: [ws("a"), ws("b")],
    panes: [
      pane("t1", "a"),
      pane("t2", "a", "chat", { archived: true }),
      pane("term1", "a", "terminal"),
      pane("prev1", "a", "preview", { url: "http://localhost:3000" }),
      pane("t3", "b"),
    ],
    profiles: [],
    activeWorkspace: "b",
    focusedPane: "t3",
    section: "threads",
    layout: "top",
    ...over,
  };
}

test("removes the project and every pane in it, and leaves other projects alone", () => {
  const { next, undo } = removeProjectFrom(session(), "a");
  assert.deepEqual(next.workspaces.map((w) => w.id), ["b"]);
  assert.deepEqual(next.panes.map((p) => p.id), ["t3"]);
  assert.ok(undo);
  assert.equal(undo.workspace.id, "a");
});

test("undo keeps the workspace and only its chat panes", () => {
  const { undo } = removeProjectFrom(session(), "a");
  assert.deepEqual(undo.panes.map((p) => p.id), ["t1", "t2"]);
  assert.ok(undo.panes.every((p) => p.kind === "chat"));
});

test("restore puts the project and its threads back, without duplicating", () => {
  const removed = removeProjectFrom(session(), "a");
  const back = restoreProjectTo(removed.next, removed.undo);
  // Back in its old place, above b, not at the bottom.
  assert.deepEqual(back.workspaces.map((w) => w.id), ["a", "b"]);
  assert.deepEqual(back.panes.map((p) => p.id).sort(), ["t1", "t2", "t3"]);

  const again = restoreProjectTo(back, removed.undo);
  assert.equal(again.workspaces.length, 2);
  assert.equal(again.panes.length, 3);
});

test("restore skips a thread that is already in the list", () => {
  const removed = removeProjectFrom(session(), "a");
  const withT1 = { ...removed.next, panes: [...removed.next.panes, pane("t1", "a", "chat", { title: "newer" })] };
  const back = restoreProjectTo(withT1, removed.undo);
  assert.equal(back.panes.filter((p) => p.id === "t1").length, 1);
  assert.equal(back.panes.find((p) => p.id === "t1").title, "newer");
});

test("an unknown id changes nothing and gives no undo", () => {
  const before = session();
  const { next, undo } = removeProjectFrom(before, "missing");
  assert.equal(undo, null);
  assert.deepEqual(next, before);
});

test("the active project and focused pane are cleared when they are removed", () => {
  const removed = removeProjectFrom(session({ activeWorkspace: "a", focusedPane: "t1" }), "a");
  assert.equal(removed.next.activeWorkspace, null);
  assert.equal(removed.next.focusedPane, null);
});

test("the active project and focused pane are kept when they are elsewhere", () => {
  const removed = removeProjectFrom(session({ activeWorkspace: "b", focusedPane: "t3" }), "a");
  assert.equal(removed.next.activeWorkspace, "b");
  assert.equal(removed.next.focusedPane, "t3");
});

test("the question says the folder on disk is not deleted", () => {
  const one = removeProjectWords("Gronk", 1);
  assert.equal(one.title, "Remove Gronk from the list?");
  assert.equal(one.action, "Remove project");
  assert.match(one.body, /folder on disk isn't deleted/);
  assert.match(one.body, /Its thread leaves the app/);

  const many = removeProjectWords("Gronk", 3);
  assert.match(many.body, /Its 3 threads leave the app/);

  const none = removeProjectWords("Gronk", 0);
  assert.doesNotMatch(none.body, /thread/);
});

test("archived threads are named apart, so the count matches the project's own", () => {
  assert.match(removeProjectWords("notes", 1, 1).body, /Its thread and 1 archived thread leave the app with it\. Undo brings them back/);
  assert.match(removeProjectWords("notes", 2, 3).body, /Its 2 threads and 3 archived threads leave/);
  assert.match(removeProjectWords("notes", 0, 1).body, /Its 1 archived thread leaves the app with it\. Undo brings it back/);
});
