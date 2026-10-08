import test from "node:test";
import assert from "node:assert/strict";
import { foldChoice, readFolds, archivedDetail, archivedLine, machineGroups, machineNote, recentFirst, strongestDot, threadState } from "../src/phone/threadListRules.ts";

const calm = { down: false, waiting: false, working: [], unread: false };

test("a thread shows one dot, strongest state first", () => {
  assert.deepEqual(threadState(calm), { dot: "", words: "", tone: "" });
  assert.deepEqual(threadState({ ...calm, unread: true }), { dot: "unread", words: "", tone: "" });
  assert.deepEqual(threadState({ ...calm, unread: true, working: ["Gronk"] }), { dot: "work", words: "Gronk is working", tone: "work" });
  assert.deepEqual(threadState({ ...calm, working: ["Gronk"], waiting: true }), { dot: "wait", words: "Waiting on you", tone: "wait" });
  assert.deepEqual(threadState({ down: true, waiting: true, working: ["Gronk"], unread: true }), { dot: "", words: "Paused", tone: "paused" });
});

test("the working line names one or two bots and counts more", () => {
  assert.equal(threadState({ ...calm, working: ["Null", "Gronk"] }).words, "Null and Gronk are working");
  assert.equal(threadState({ ...calm, working: ["Null", "Gronk", "Jigga"] }).words, "3 bots are working");
});

test("a closed project takes its strongest thread's dot", () => {
  assert.equal(strongestDot([]), "");
  assert.equal(strongestDot(["", "unread"]), "unread");
  assert.equal(strongestDot(["unread", "work", ""]), "work");
  assert.equal(strongestDot(["work", "wait", "unread"]), "wait");
});

test("Recent puts waiting, then working, then newest, with paused threads last", () => {
  const rows = [
    { id: "old", at: 10, state: calm },
    { id: "new", at: 50, state: calm },
    { id: "paused", at: 99, state: { ...calm, down: true } },
    { id: "work", at: 20, state: { ...calm, working: ["Gronk"] } },
    { id: "wait", at: 5, state: { ...calm, waiting: true } },
  ];
  const order = recentFirst(rows, (row) => threadState(row.state), (row) => row.at, 10).map((row) => row.id);
  assert.deepEqual(order, ["wait", "work", "new", "old", "paused"]);
});

test("Recent shows four, and leaves out threads with no activity unless something is happening", () => {
  const rows = [1, 2, 3, 4, 5].map((at) => ({ id: `t${at}`, at, state: calm }));
  assert.deepEqual(recentFirst(rows, (row) => threadState(row.state), (row) => row.at).map((row) => row.id), ["t5", "t4", "t3", "t2"]);
  const fresh = [{ id: "never", at: 0, state: calm }, { id: "busy", at: 0, state: { ...calm, working: ["Null"] } }];
  assert.deepEqual(recentFirst(fresh, (row) => threadState(row.state), (row) => row.at).map((row) => row.id), ["busy"]);
});

test("projects group under their machine: Mac first, servers next, unpaired machines last", () => {
  const links = [
    { id: "srv", name: "Apex-Terminal", kind: "server", status: "online" },
    { id: "local", name: "MacBook Pro", kind: "mac", status: "online" },
    { id: "empty", name: "Spare", kind: "server", status: "offline" },
  ];
  const projects = [
    { name: "relay", host: "srv" },
    { name: "apex-deck", host: "local" },
    { name: "old", host: "gone" },
    { name: "ios", host: "local" },
  ];
  const groups = machineGroups(projects, (project) => project.host, links);
  assert.deepEqual(groups.map((group) => [group.hostId, group.name, group.projects.map((project) => project.name)]), [
    ["local", "MacBook Pro", ["apex-deck", "ios"]],
    ["srv", "Apex-Terminal", ["relay"]],
    ["empty", "Spare", []],
    ["gone", "gone", ["old"]],
  ]);
  assert.equal(groups[3].link, null);
});

test("a machine's heading says Asleep or Offline with Retry, and only dims when it's down", () => {
  assert.deepEqual(machineNote({ id: "local", name: "Mac", kind: "mac", status: "online" }), { words: "", action: null, down: false });
  assert.deepEqual(machineNote({ id: "local", name: "Mac", kind: "mac", status: "offline" }), { words: "Asleep", action: "Retry", down: true });
  assert.deepEqual(machineNote({ id: "srv", name: "S", kind: "server", status: "offline" }), { words: "Offline", action: "Retry", down: true });
  assert.deepEqual(machineNote({ id: "srv", name: "S", kind: "server", status: "connecting" }), { words: "Connecting…", action: null, down: false });
  assert.deepEqual(machineNote({ id: "srv", name: "S", kind: "server", status: "offline", problem: "Wrong token" }), { words: "Can't connect", action: "Fix", down: true });
  assert.deepEqual(machineNote(null), { words: "Not paired", action: "Pair", down: true });
});

test("the Archived line counts the archived threads", () => {
  assert.equal(archivedLine(3), "Archived (3)");
  assert.equal(archivedLine(1), "Archived (1)");
});

test("an archived thread's detail line joins its project, machine and age, leaving out what isn't known", () => {
  assert.equal(archivedDetail({ project: "apex-deck", machine: "MacBook Pro", age: "3h" }), "apex-deck · MacBook Pro · 3h");
  assert.equal(archivedDetail({ project: "apex-deck", machine: "MacBook Pro" }), "apex-deck · MacBook Pro");
  assert.equal(archivedDetail({ project: "", machine: "Apex-Terminal", age: "" }), "Apex-Terminal");
  assert.equal(archivedDetail({}), "");
});


test("folds prefer a saved choice, otherwise the project default, otherwise open", () => {
  assert.equal(foldChoice({ "project:p": false }, "project:p", true), false);
  assert.equal(foldChoice({ "project:p": true }, "project:p", false), true);
  assert.equal(foldChoice({}, "project:p", true), true);
  assert.equal(foldChoice({}, "section:pinned"), false);
  assert.equal(foldChoice({}, "machine:local"), false);
});

test("stored folds accept boolean prefixed choices and recover from damaged storage", () => {
  assert.deepEqual(readFolds(null), {});
  assert.deepEqual(readFolds("broken"), {});
  assert.deepEqual(readFolds("null"), {});
  assert.deepEqual(readFolds('[true]'), {});
  assert.deepEqual(readFolds('{"section:recent":false,"machine:local":true,"project:p":true,"project:q":"false","old":true}'), {
    "section:recent": false, "machine:local": true, "project:p": true,
  });
});
