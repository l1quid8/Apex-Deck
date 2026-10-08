import test from "node:test";
import assert from "node:assert/strict";
import { botsIn, filterLibrary, threadExists, workspaceForRoom, workspacesIn } from "../src/library.ts";

const threads = [
  { id: "t1", workspaceId: "w1" },
  { id: "t2", workspaceId: "w2" },
];
const item = (file, room, by, created) => ({ file, kind: "image", source: "chat", room, by, created, path: `/lib/${file}` });
const items = [
  item("a.png", "t1", "Clef", 100),
  item("b.png", "t2", "Jigga", 300),
  item("c.png", "t1", "Jigga", 200),
  item("d.png", "gone", undefined, 400),
  item("e.png", "gone", "Clef", 50),
];

test("pictures list newest first and each filter narrows them", () => {
  const all = filterLibrary(items, { bot: null, workspace: null }, threads);
  assert.deepEqual(all.map((i) => i.file), ["d.png", "b.png", "c.png", "a.png", "e.png"]);
  assert.deepEqual(filterLibrary(items, { bot: "Jigga", workspace: null }, threads).map((i) => i.file), ["b.png", "c.png"]);
  assert.deepEqual(filterLibrary(items, { bot: null, workspace: "w1" }, threads).map((i) => i.file), ["c.png", "a.png"]);
  assert.deepEqual(filterLibrary(items, { bot: "Clef", workspace: "w1" }, threads).map((i) => i.file), ["a.png"]);
});

test("pictures whose thread is gone match only the All workspaces filter", () => {
  assert.equal(workspaceForRoom("gone", threads), null);
  assert.equal(filterLibrary(items, { bot: null, workspace: "w2" }, threads).some((i) => i.room === "gone"), false);
});

test("a thread counts as openable only while it is on the deck", () => {
  assert.equal(threadExists("t1", threads), true);
  assert.equal(threadExists("gone", threads), false);
});

test("bot and workspace lists skip blank bot names and gone threads", () => {
  assert.deepEqual(botsIn([...items, item("f.png", "t1", "  ", 1)]), ["Clef", "Jigga"]);
  assert.deepEqual(workspacesIn(items, threads), ["w1", "w2"]);
});

test("the machine filter keeps one machine's pictures; items without a machine match only All machines", async () => {
  const tagged = [{ ...item("a.png", "t1", "Clef", 100), machine: "local" }, { ...item("a.png", "t2", "Gronk", 200), machine: "hetzner" }];
  assert.deepEqual(filterLibrary(tagged, { bot: null, workspace: null, machine: "hetzner" }, threads).map((i) => i.by), ["Gronk"]);
  assert.equal(filterLibrary(tagged, { bot: null, workspace: null, machine: null }, threads).length, 2);
  assert.equal(filterLibrary(items, { bot: null, workspace: null, machine: "local" }, threads).length, 0);
  const { itemKey } = await import("../src/library.ts");
  assert.notEqual(itemKey(tagged[0]), itemKey(tagged[1]));
});

test("a machine that can't list says why: offline, an older helper, or the error", async () => {
  const { loadOutcome, machineNote } = await import("../src/library.ts");
  assert.deepEqual(loadOutcome(new Error("unknown variant `library_list`, expected one of `room_post`")), { kind: "old" });
  assert.deepEqual(loadOutcome(new Error("Not connected to the host; nothing was queued.")), { kind: "offline" });
  assert.deepEqual(loadOutcome(new Error("timed out")), { kind: "offline" });
  assert.deepEqual(loadOutcome("disk full"), { kind: "failed", message: "disk full" });
  assert.equal(machineNote("Hetzner", { kind: "ok" }), null);
  assert.equal(machineNote("Hetzner", { kind: "offline" }), "Hetzner offline. Its pictures show when it's back.");
  assert.match(machineNote("Hetzner", { kind: "old" }), /older apex-daemon/);
  assert.match(machineNote("Hetzner", { kind: "failed", message: "disk full" }), /Couldn't load Hetzner's Library: disk full/);
});
