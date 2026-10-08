import test from "node:test";
import assert from "node:assert/strict";
import { remoteSessionEdit } from "../src/sessionSync.ts";

const ws = [{ id: "w", name: "apex-deck", path: "/p" }];
const chat = (id, extra = {}) => ({ id, workspaceId: "w", kind: "chat", title: id, ...extra });
const ours = { tag: "mac", seq: 3 };
const session = (panes, savedBy) => ({ version: 1, workspaces: ws, panes, savedBy });

test("the phone's rename comes through", () => {
  const edit = remoteSessionEdit({ workspaces: ws, panes: [chat("a")] }, session([chat("a", { title: "Renamed" })], "phone"), ours);
  assert.equal(edit.panes[0].title, "Renamed");
});

test("a thread the phone started comes through", () => {
  const edit = remoteSessionEdit({ workspaces: ws, panes: [chat("a")] }, session([chat("a"), chat("b")], "phone"), ours);
  assert.deepEqual(edit.panes.map((p) => p.id), ["a", "b"]);
});

test("an older phone build that copies the Mac's latest tag still comes through", () => {
  assert.ok(remoteSessionEdit({ workspaces: ws, panes: [chat("a")] }, session([chat("a", { title: "x" })], "mac:3"), ours));
});

test("the echo of our own save, in any key order, changes nothing", () => {
  const remote = { savedBy: "mac:3", panes: [{ title: "a", kind: "chat", workspaceId: "w", id: "a" }], workspaces: ws, version: 1 };
  assert.equal(remoteSessionEdit({ workspaces: ws, panes: [chat("a")] }, remote, ours), null);
});

test("an older save of ours arriving late does not undo newer edits", () => {
  assert.equal(remoteSessionEdit({ workspaces: ws, panes: [chat("a", { title: "new" })] }, session([chat("a")], "mac:2"), ours), null);
});

test("a session without threads or projects is ignored", () => {
  assert.equal(remoteSessionEdit({ workspaces: ws, panes: [] }, { version: 1 }, ours), null);
  assert.equal(remoteSessionEdit({ workspaces: ws, panes: [] }, null, ours), null);
});
