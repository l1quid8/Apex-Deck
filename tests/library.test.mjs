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
