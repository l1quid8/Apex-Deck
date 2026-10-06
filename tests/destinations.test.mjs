import test from "node:test";
import assert from "node:assert/strict";
import { threadStarted, chooseOutcome, workInRows, pickerRows, pickerMatches, shortName } from "../src/destinations.ts";

const ws = [
  { id: "deck", name: "apex-deck", path: "/Users/t/apex-deck", family: "apex-deck" },
  { id: "at1", name: "apex-deck", path: "/home/l/apex-deck", hostId: "at", family: "apex-deck" },
  { id: "at2", name: "apex-deck", path: "/home/l/code/apex-deck", hostId: "at", family: "apex-deck" },
  { id: "api", name: "staging-api", path: "/srv/api", hostId: "st", family: "staging-api" },
  { id: "gone", name: "apex-deck", path: "/old/apex-deck", family: "apex-deck", hidden: true },
];

test("a thread starts with its first message after it was made or forked, or as Send is pressed", () => {
  assert.equal(threadStarted(0, 0, false), false);
  assert.equal(threadStarted(1, 0, false), true);
  assert.equal(threadStarted(4, 4, false), false);
  assert.equal(threadStarted(5, 4, false), true);
  assert.equal(threadStarted(0, 0, true), true);
});

test("a choice moves an unstarted thread and asks for a started one", () => {
  assert.equal(chooseOutcome("deck", "deck", true), "same");
  assert.equal(chooseOutcome("deck", "at1", false), "move");
  assert.equal(chooseOutcome("deck", "at1", true), "ask");
  assert.equal(chooseOutcome("at1", "at2", true), "ask", "another folder on the same machine is still another destination");
});

test("Work in lists every machine, one row per folder, and keeps the current ✓ when offline", () => {
  const rows = workInRows(ws, ["local", "at", "hz", "st"], ws[1], (h) => h === "at");
  assert.deepEqual(rows.map((r) => [r.hostId, r.workspaceId, r.first, r.offline, r.current]), [
    ["local", "deck", true, false, false],
    ["at", "at1", true, true, true], ["at", "at2", false, true, false],
    ["hz", null, true, false, false],
    ["st", null, true, false, false]]);
  assert.equal(rows[2].path, "/home/l/code/apex-deck");
});

test("a project with no folder lists only This Mac's scratch row and the servers' no-copy rows", () => {
  const none = { id: "none", name: "No project", path: "" };
  const rows = workInRows([...ws, none], ["local", "at"], none, () => false);
  assert.deepEqual(rows.map((r) => [r.hostId, r.workspaceId, r.current]), [["local", "none", true], ["at", null, false]]);
});

test("the picker lists recently used projects first and finds by name, server or folder", () => {
  const panes = [{ id: "p", workspaceId: "api", kind: "chat", title: "t", activeAt: 9 }, { id: "q", workspaceId: "at2", kind: "chat", title: "u", activeAt: 3 }];
  const rows = pickerRows(ws, panes, "deck", (h) => h === "st");
  assert.deepEqual(rows.map((r) => r.workspace.id), ["api", "at2", "deck", "at1"]);
  assert.equal(rows.find((r) => r.workspace.id === "deck").current, true);
  assert.equal(rows[0].offline, true);
  assert.equal(pickerMatches(rows[0], "Staging", "stag"), true);
  assert.equal(pickerMatches(rows[0], "Staging", "/srv"), true);
  assert.equal(pickerMatches(rows[0], "Staging", "STAGING-api"), true);
  assert.equal(pickerMatches(rows[0], "Staging", "hetzner"), false);
  assert.equal(pickerMatches(rows[2], "This Mac", "this mac"), true);
});

test("long project names shorten in the middle, short ones stay", () => {
  assert.equal(shortName("apex-smoke-test"), "apex…test");
  assert.equal(shortName("apex-deck"), "apex-deck");
  assert.equal(shortName("staging-api-service"), "stag…vice");
});
