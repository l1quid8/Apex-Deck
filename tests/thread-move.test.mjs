import test from "node:test";
import assert from "node:assert/strict";
import { placeThread, unsupported } from "../src/threadMove.ts";

const snap = (transcript = []) => ({ participants: [{ id: "bot" }], options: { policy: "mention", max_bot_hops: 3 }, transcript, pins: [] });
function fake(name, { importError, createErrorIn } = {}) {
  const calls = [];
  return {
    calls,
    roomImport: async (...args) => { calls.push(["import", ...args]); if (importError) throw new Error(importError); },
    roomCreate: async (...args) => { calls.push(["create", ...args]); if (args[3] === createErrorIn) throw new Error("disk full"); return snap(); },
    roomDelete: async (...args) => { calls.push(["delete", ...args]); },
  };
}

test("to another machine: import there first, then delete the old copy", async () => {
  const from = fake("mac"); const to = fake("at");
  assert.equal(await placeThread({ from, to, id: "t", snapshot: snap(), cwd: "/srv/x", sameHost: false, hostName: "AT" }), "imported");
  assert.deepEqual(to.calls, [["import", "t", snap(), "/srv/x", false]]);
  assert.deepEqual(from.calls, [["delete", "t"]]);
});

test("to another folder on the same machine: one replace, nothing else", async () => {
  const host = fake("at");
  await placeThread({ from: host, to: host, id: "t", snapshot: snap(), cwd: "/srv/y", sameHost: true, hostName: "AT" });
  assert.deepEqual(host.calls, [["import", "t", snap(), "/srv/y", true]]);
});

test("an older helper without room_import still takes a thread with no history, with its bots", async () => {
  const old = "unknown variant `room_import`, expected one of `session_load`";
  const from = fake("mac"); const to = fake("at", { importError: old });
  assert.equal(await placeThread({ from, to, id: "t", snapshot: snap(), cwd: "/srv/x", sameHost: false, hostName: "AT" }), "recreated");
  assert.deepEqual(to.calls.map((c) => c[0]), ["import", "create"]);
  assert.deepEqual(to.calls[1], ["create", "t", [{ id: "bot" }], { policy: "mention", max_bot_hops: 3 }, "/srv/x"]);
  assert.deepEqual(from.calls, [["delete", "t"]]);
  const same = fake("at", { importError: old });
  await placeThread({ from: same, to: same, id: "t", snapshot: snap(), cwd: "/srv/y", fromCwd: "/srv/x", sameHost: true, hostName: "AT" });
  assert.deepEqual(same.calls.map((c) => c[0]), ["import", "delete", "create"]);
});

test("an older helper that can't make the room in the new folder gets it back in the old one", async () => {
  const same = fake("at", { importError: "unknown variant `room_import`", createErrorIn: "/srv/y" });
  await assert.rejects(placeThread({ from: same, to: same, id: "t", snapshot: snap(), cwd: "/srv/y", fromCwd: "/srv/x", sameHost: true, hostName: "AT" }), /disk full/);
  assert.deepEqual(same.calls.slice(1), [
    ["delete", "t"],
    ["create", "t", [{ id: "bot" }], { policy: "mention", max_bot_hops: 3 }, "/srv/y"],
    ["create", "t", [{ id: "bot" }], { policy: "mention", max_bot_hops: 3 }, "/srv/x"],
  ]);
});

test("history can't go to an older helper; nothing is deleted when placing fails", async () => {
  const from = fake("mac"); const to = fake("at", { importError: "unknown variant `room_import`" });
  await assert.rejects(placeThread({ from, to, id: "t", snapshot: snap([{ seq: 0 }]), cwd: "/x", sameHost: false, hostName: "AT" }), /AT's apex-daemon is too old/);
  assert.deepEqual(from.calls, []);
  const broken = fake("at", { importError: "disk full" });
  await assert.rejects(placeThread({ from, to: broken, id: "t", snapshot: snap(), cwd: "/x", sameHost: false, hostName: "AT" }), /disk full/);
  assert.deepEqual(from.calls, []);
});

test("an unsupported command is told apart from other failures", () => {
  assert.equal(unsupported(new Error("unknown variant `room_import`, expected one of"), "room_import"), true);
  assert.equal(unsupported("Error: unknown command room_import", "room_import"), true);
  assert.equal(unsupported(new Error("a thread with that id already exists"), "room_import"), false);
});

test("history mentions attachments when a message carried one", async () => {
  const { historyHasAttachments } = await import("../src/threadMove.ts");
  assert.equal(historyHasAttachments([{ text: "look\nAttached image: /a/b.png" }]), true);
  assert.equal(historyHasAttachments([{ text: "no files here" }, { text: "Attached folder: /x/" }]), true);
  assert.equal(historyHasAttachments([{ text: "I attached nothing" }]), false);
});
