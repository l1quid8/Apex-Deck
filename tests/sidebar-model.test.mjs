import test from "node:test";
import assert from "node:assert/strict";
import { sidebarSections, twinPath, homeShort, hostTints, HOST_TINTS, ageWords, archiveThreads, unarchiveThreads, setUnread, noteActive, toggleProjectPin, setCollapsed } from "../src/sidebarModel.ts";
import { normalizeWorkspaces } from "../src/hostSession.ts";

const ws = [
  { id: "deck", name: "apex-deck", path: "/Users/t/apex-deck" },
  { id: "deckAT", name: "apex-deck", path: "/home/l1/apex-deck", hostId: "at" },
  { id: "two", name: "apex-deck", path: "/home/l1/code/apex-deck", hostId: "at" },
  { id: "gone", name: "old", path: "/old", hidden: true },
];
const chat = (id, workspaceId, extra = {}) => ({ id, workspaceId, kind: "chat", title: id, ...extra });

test("Pinned, Projects and Recents list threads once each where Codex shows them", () => {
  const panes = [
    chat("a", "deck", { activeAt: 30 }), chat("b", "deckAT", { pinned: true, activeAt: 50 }),
    chat("c", "two", { archived: true, closed: true, activeAt: 90 }), chat("d", "gone", { activeAt: 99 }),
    { id: "t", workspaceId: "deck", kind: "terminal", title: "Codex" }, chat("e", "deck", { activeAt: 10 }),
  ];
  const s = sidebarSections(panes, ws, "threads", new Set(["e"]));
  assert.deepEqual(s.pinned.map((p) => p.id), ["b"]);
  assert.deepEqual(s.projects.map((b) => [b.workspace.id, b.panes.map((p) => p.id)]), [["deck", ["a"]], ["deckAT", []], ["two", []]]);
  assert.deepEqual(s.recents.map((p) => p.id), ["b", "a"]);
  assert.deepEqual(s.archived.map((p) => p.id), ["c"]);
  const code = sidebarSections(panes, ws, "code", new Set());
  assert.deepEqual(code.projects[0].panes.map((p) => p.id), ["t"]);
  assert.deepEqual(code.recents, []);
  assert.deepEqual(sidebarSections(panes, ws, "agents", new Set()).projects.map((b) => b.panes.length), [0, 0, 0]);
});

test("pinned projects lead the Projects list; the rest keep their order", () => {
  const list = toggleProjectPin(ws, "two");
  assert.deepEqual(sidebarSections([], list, "threads", new Set()).projects.map((b) => b.workspace.id), ["two", "deck", "deckAT"]);
  assert.equal(toggleProjectPin(list, "two").find((w) => w.id === "two").pinned, undefined);
});

test("Recents keeps the five most recently active threads and skips never-active ones", () => {
  const panes = Array.from({ length: 7 }, (_, i) => chat(`r${i}`, "deck", i === 6 ? {} : { activeAt: i + 1 }));
  assert.deepEqual(sidebarSections(panes, ws, "threads", new Set()).recents.map((p) => p.id), ["r5", "r4", "r3", "r2", "r1"]);
});

test("two folders with one name on one machine each show their path", () => {
  assert.equal(twinPath(ws[1], ws), "~/apex-deck");
  assert.equal(twinPath(ws[2], ws), "~/code/apex-deck");
  assert.equal(twinPath(ws[0], ws), "");
  assert.equal(homeShort("/root/apex-deck"), "~/apex-deck");
  assert.equal(homeShort("/Users/t/x"), "~/x");
  assert.equal(homeShort("/srv/api"), "/srv/api");
});

test("each server keeps a distinct tint, and earlier servers keep theirs when one is added", () => {
  const two = hostTints(["at", "hz"]);
  assert.notEqual(two.get("at"), two.get("hz"));
  const three = hostTints(["at", "hz", "lab"]);
  assert.equal(three.get("at"), two.get("at"));
  assert.equal(three.get("hz"), two.get("hz"));
  assert.ok(HOST_TINTS.includes(three.get("lab")));
});

test("ages read like Codex: now, minutes, hours, days, weeks", () => {
  assert.deepEqual([0, 59e3, 5 * 60e3, 3 * 3600e3, 2 * 86400e3, 15 * 86400e3].map(ageWords), ["now", "now", "5m", "3h", "2d", "2w"]);
});

test("archive closes threads and restore brings them back closed; unread and activity persist as fields", () => {
  const panes = [chat("a", "deck"), { id: "t", workspaceId: "deck", kind: "terminal", title: "T" }];
  const archived = archiveThreads(panes, ["a", "t"]);
  assert.deepEqual(archived[0], { ...panes[0], archived: true, closed: true });
  assert.equal(archived[1], panes[1]);
  assert.deepEqual(unarchiveThreads(archived, ["a"])[0], { ...panes[0], closed: true });
  assert.equal(setUnread(panes, "a", true)[0].unread, true);
  assert.equal("unread" in setUnread(setUnread(panes, "a", true), "a", false)[0], false);
  const active = noteActive(panes, "a", 100);
  assert.equal(active[0].activeAt, 100);
  assert.equal(noteActive(active, "a", 50), active);
  assert.equal(setCollapsed(ws, "deck", true)[0].collapsed, true);
  assert.equal("collapsed" in setCollapsed(setCollapsed(ws, "deck", true), "deck", false)[0], false);
});

test("saved project pins and collapsed state survive a restart", () => {
  const [w] = normalizeWorkspaces([{ id: "a", name: "A", path: "/a", pinned: true, collapsed: true, junk: 1 }]);
  assert.equal(w.pinned, true);
  assert.equal(w.collapsed, true);
  assert.equal("junk" in w, false);
});
