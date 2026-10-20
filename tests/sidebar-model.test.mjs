import test from "node:test";
import assert from "node:assert/strict";
import { sidebarSections, twinPath, homeShort, hostTints, HOST_TINTS, ageWords, archiveThreads, unarchiveThreads, setUnread, noteActive, toggleProjectPin, setCollapsed } from "../src/sidebarModel.ts";
import { normalizeWorkspaces } from "../src/hostSession.ts";
import * as model from "../src/sidebarModel.ts";

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

test("pinned projects lead their host group; the rest keep their order", () => {
  const list = toggleProjectPin(ws, "two");
  const groups = model.projectGroups(sidebarSections([], list, "threads", new Set()).projects, ["at"]);
  assert.deepEqual(groups.map(g => [g.hostId, g.projects.map(p => p.workspace.id)]), [["local", ["deck"]], ["at", ["two", "deckAT"]]]);
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

const mixed = [
  { id: "a", name: "same", path: "/a", hostId: "at" },
  { id: "l", name: "same", path: "/l" },
  { id: "b", name: "B", path: "/b", hostId: "at" },
  { id: "x", name: "X", path: "/x", hostId: "missing" },
  { id: "m", name: "M", path: "/m", hostId: "local" },
  { id: "hidden", name: "Hidden", path: "/h", hostId: "at", hidden: true },
];
const projects = (list) => sidebarSections([], list, "threads", new Set()).projects;
const groupIds = (list) => model.projectGroups(projects(list), ["at"]).map(g => [g.hostId, g.projects.map(p => p.workspace.id)]);

test("project groups use host IDs, local first, and retain unavailable hosts", () => {
  assert.deepEqual(groupIds(mixed), [["local", ["l", "m"]], ["at", ["a", "b"]], ["missing", ["x"]]]);
});

test("within-host moves persist through normalization without changing project identity", () => {
  const next = model.reorderProject(mixed, "b", "a", false);
  assert.deepEqual(groupIds(next), [["local", ["l", "m"]], ["at", ["b", "a"]], ["missing", ["x"]]]);
  assert.deepEqual(groupIds(normalizeWorkspaces(JSON.parse(JSON.stringify(next)))), groupIds(next));
  for (const item of mixed) {
    const { sidebarOrder, ...saved } = next.find(w => w.id === item.id);
    assert.deepEqual(saved, item);
  }
  assert.equal(next.find(w => w.id === "l"), mixed[1]);
  const restored = model.reorderProject(next, "b", "a", true);
  assert.deepEqual(groupIds(restored)[1], ["at", ["a", "b"]]);
});

test("cross-host, hidden, missing and self moves are rejected", () => {
  for (const [from, to] of [["a", "l"], ["a", "hidden"], ["hidden", "a"], ["absent", "b"], ["b", "absent"], ["a", "a"]]) {
    assert.equal(model.reorderProject(mixed, from, to, false), mixed, `${from} to ${to}`);
  }
});

test("custom order accepts new projects and pin actions still move within their host", () => {
  const next = [...model.reorderProject(mixed, "b", "a", false), { id: "c", name: "C", path: "/c", hostId: "at" }];
  assert.deepEqual(groupIds(next)[1], ["at", ["b", "a", "c"]]);
  const pinned = toggleProjectPin(next, "a");
  assert.deepEqual(groupIds(pinned)[1], ["at", ["a", "b", "c"]]);
  assert.deepEqual(groupIds(toggleProjectPin(pinned, "a"))[1], ["at", ["a", "b", "c"]]);
  const manual = model.reorderProject(pinned, "b", "a", false);
  assert.equal(manual, pinned, "an unpinned project cannot cross the pinned boundary");
});

const projectList = (items) => items.map((item) => ({ name: item.id.toUpperCase(), path: `/${item.id}`, ...item }));
const projectIds = (list) => projects(list).map(p => p.workspace.id);

test("saved order cannot put an unpinned project ahead of a pinned project", () => {
  const list = projectList([
    { id: "a", sidebarOrder: 0 }, { id: "b", pinned: true, sidebarOrder: 3 },
    { id: "c", pinned: true, sidebarOrder: 1 }, { id: "d", sidebarOrder: 2 },
  ]);
  assert.deepEqual(projectIds(list), ["c", "b", "a", "d"]);
});

test("drag cannot cross the pinned boundary in either direction", () => {
  const list = projectList([{ id: "a", pinned: true }, { id: "b", pinned: true }, { id: "c" }, { id: "d" }]);
  for (const [source, target] of [["a", "c"], ["b", "d"], ["c", "a"], ["d", "b"]]) {
    for (const after of [false, true]) {
      assert.equal(model.reorderProject(list, source, target, after), list, `${source} to ${target}, after=${after}`);
    }
  }
});

test("pinning appends to pinned and unpinning prepends to unpinned before any saved drag", () => {
  const list = projectList([{ id: "a" }, { id: "b", pinned: true }, { id: "c", pinned: true }, { id: "d" }]);
  const pinned = toggleProjectPin(list, "a");
  assert.deepEqual(projectIds(pinned), ["b", "c", "a", "d"]);
  assert.equal(pinned.find(w => w.id === "a").pinned, true);
  const unpinned = toggleProjectPin(list, "b");
  assert.deepEqual(projectIds(unpinned), ["c", "b", "a", "d"]);
  assert.equal(unpinned.find(w => w.id === "b").pinned, undefined);
});

test("pin and unpin after dragging preserve every other project's relative order", () => {
  const list = projectList([
    { id: "a", pinned: true }, { id: "b", pinned: true }, { id: "c", pinned: true },
    { id: "d" }, { id: "e" }, { id: "f" },
    { id: "remote", hostId: "at" }, { id: "hidden", hidden: true, pinned: true },
  ]);
  const dragged = model.reorderProject(model.reorderProject(list, "b", "a", false), "f", "d", false);
  assert.deepEqual(projectIds(dragged), ["b", "a", "c", "f", "d", "e", "remote"]);
  const pinned = toggleProjectPin(dragged, "e");
  assert.deepEqual(projectIds(pinned), ["b", "a", "c", "e", "f", "d", "remote"]);
  const unpinned = toggleProjectPin(pinned, "a");
  assert.deepEqual(projectIds(unpinned), ["b", "c", "e", "a", "f", "d", "remote"]);
  for (const id of ["remote", "hidden"]) assert.equal(unpinned.find(w => w.id === id), list.find(w => w.id === id));
  assert.deepEqual(projectIds(normalizeWorkspaces(JSON.parse(JSON.stringify(unpinned)))), ["b", "c", "e", "a", "f", "d", "remote"]);
});

test("invalid saved sidebar ranks are discarded", () => {
  for (const sidebarOrder of [-1, NaN, Infinity, "2", 1.5]) {
    assert.equal(normalizeWorkspaces([{ ...mixed[0], sidebarOrder }])[0].sidebarOrder, undefined);
  }
  assert.equal(normalizeWorkspaces([{ ...mixed[0], sidebarOrder: 2 }])[0].sidebarOrder, 2);
});
