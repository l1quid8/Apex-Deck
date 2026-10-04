import test from "node:test";
import assert from "node:assert/strict";
import { activeAfter, addFolders, hiddenWorkspaces, listedPanes, openThreadIds, removeWorkspacePanes, renameWorkspace, reopenThreads, setHidden, shownWorkspaces } from "../src/workspaces.ts";
import { loadedPanes, savedPanes } from "../src/closing.ts";

const ws = (id, extra = {}) => ({ id, name: id, path: `/code/${id}`, ...extra });
const chat = (id, extra = {}) => ({ id, workspaceId: "w", kind: "chat", title: id, ...extra });
const term = (id, extra = {}) => ({ id, workspaceId: "w", kind: "terminal", title: id, ...extra });

test("a removed workspace leaves the list and comes back unchanged", () => {
  const removed = setHidden([ws("w"), ws("v")], "w", true);
  assert.deepEqual(shownWorkspaces(removed).map((w) => w.id), ["v"]);
  assert.deepEqual(setHidden(removed, "w", false).find((w) => w.id === "w"), { ...ws("w"), hidden: false });
  // Saved before this change: no hidden field means listed.
  assert.deepEqual(shownWorkspaces([ws("old")]).map((w) => w.id), ["old"]);
});

test("removing a workspace ends its terminals and closes its threads, deleting nothing", () => {
  const panes = [chat("a"), chat("b", { closed: true }), term("t"), chat("c", { workspaceId: "v" }), term("u", { workspaceId: "v" })];
  assert.deepEqual(openThreadIds(panes, "w"), ["a"]);
  const after = removeWorkspacePanes(panes, "w");
  assert.deepEqual(after.map((p) => [p.id, Boolean(p.closed)]), [["a", true], ["b", true], ["c", false], ["u", false]]);
  assert.deepEqual(reopenThreads(after, ["a"]).map((p) => [p.id, Boolean(p.closed)]), [["a", false], ["b", true], ["c", false], ["u", false]]);
});

test("panes of a removed workspace are not mounted", () => {
  const list = setHidden([ws("w"), ws("v")], "w", true);
  assert.deepEqual(listedPanes([chat("a"), chat("c", { workspaceId: "v" })], list).map((p) => p.id), ["c"]);
});

test("after removing a workspace and quitting, its threads load back and it stays removed", () => {
  const workspaces = setHidden([ws("w"), ws("v")], "w", true);
  const panes = removeWorkspacePanes([chat("a"), chat("b", { closed: true }), term("t"), chat("c", { workspaceId: "v" })], "w");
  // What App writes to the session file, and reads back on the next launch.
  const file = JSON.parse(JSON.stringify({ workspaces, panes: savedPanes(panes) }));
  const loaded = loadedPanes(file.panes, file.workspaces.map((w) => w.id));
  assert.deepEqual(loaded.map((p) => [p.id, p.closed]), [["a", true], ["b", true], ["c", false]]);
  assert.deepEqual(shownWorkspaces(file.workspaces).map((w) => w.id), ["v"]);
  assert.deepEqual(listedPanes(loaded, file.workspaces).map((p) => p.id), ["c"]);
});

test("removing the active workspace, or the last listed one, moves on cleanly", () => {
  const list = [ws("w"), ws("v")];
  assert.equal(activeAfter(setHidden(list, "w", true), "w"), "v");
  assert.equal(activeAfter(setHidden(list, "v", true), "w"), "w");
  assert.equal(activeAfter(setHidden(setHidden(list, "w", true), "v", true), "v"), null);
  assert.equal(activeAfter(list, null), "w");
  assert.equal(activeAfter(list, "gone"), "w");
});

test("renaming a workspace changes only its name, and an empty name is ignored", () => {
  const list = [ws("w"), ws("v")];
  assert.deepEqual(renameWorkspace(list, "w", "  Apex  "), [{ ...ws("w"), name: "Apex" }, ws("v")]);
  assert.equal(renameWorkspace(list, "w", "   "), list);
});

const lastPart = (path) => path.split("/").filter(Boolean).pop() ?? "workspace";

test("adding a folder that is already listed reuses it", () => {
  const list = [ws("w")];
  const out = addFolders(list, ["/code/w"], () => "new", lastPart);
  assert.deepEqual(out.ids, ["w"]);
  assert.equal(out.list, list);
});

test("adding a folder that was removed brings it back instead of adding it twice", () => {
  const list = setHidden([ws("w"), ws("v")], "w", true);
  const out = addFolders(list, ["/code/w", "/code/new"], () => "n1", lastPart);
  assert.deepEqual(out.ids, ["w", "n1"]);
  assert.deepEqual(shownWorkspaces(out.list).map((w) => w.id), ["w", "v", "n1"]);
  assert.equal(out.list.find((w) => w.id === "n1").name, "new");
});

test("only the same folder brings a removed workspace back", () => {
  // A folderless workspace (the sample thread, every preview workspace) and
  // another folder with the same name must not match.
  const list = setHidden(setHidden([{ id: "sample", name: "Sample", path: "" }, ws("w")], "sample", true), "w", true);
  let n = 0;
  const out = addFolders(list, ["", "/other/w"], () => `n${++n}`, lastPart);
  assert.deepEqual(out.ids, ["n1", "n2"]);
  assert.deepEqual(out.list.filter((w) => w.hidden).map((w) => w.id), ["sample", "w"]);
});

test("the Removed line lists removed workspaces in their list order", () => {
  const list = setHidden(setHidden([ws("a"), ws("b"), ws("c")], "c", true), "a", true);
  assert.deepEqual(hiddenWorkspaces(list).map((w) => w.id), ["a", "c"]);
  assert.deepEqual(hiddenWorkspaces([ws("a")]), []);
});
