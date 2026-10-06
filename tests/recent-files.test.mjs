import test from "node:test";
import assert from "node:assert/strict";
import { rememberFile, fileKind, findFiles } from "../src/recentFiles.ts";

test("recent files keep the newest first, once each, and at most 30", () => {
  let list = [];
  for (let i = 0; i < 35; i++) list = rememberFile(list, `/f/${i}.txt`, i);
  list = rememberFile(list, "/f/34.txt", 99);
  assert.equal(list.length, 30);
  assert.equal(list[0].path, "/f/34.txt");
  assert.equal(list[0].name, "34.txt");
  assert.equal(list.filter((f) => f.path === "/f/34.txt").length, 1);
});

test("a file's kind comes from its extension, and search reads its name", () => {
  assert.equal(fileKind("shot.PNG"), "img");
  assert.equal(fileKind("photo.jpeg"), "img");
  assert.equal(fileKind("notes.md"), "doc");
  const list = [rememberFile([], "/a/image (22).png", 1)[0], rememberFile([], "/b/daemon-ubuntu.md", 2)[0]];
  assert.deepEqual(findFiles(list, "DAEMON").map((f) => f.name), ["daemon-ubuntu.md"]);
  assert.deepEqual(findFiles(list, "").length, 2);
});
