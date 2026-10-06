import test from "node:test";
import assert from "node:assert/strict";
import { FolderMoveUnsupported, MoveRefused, placeThread, unsupported } from "../src/threadMove.ts";

const snap = (transcript = []) => ({ participants: [{ id: "bot" }], options: { policy: "mention", max_bot_hops: 3 }, transcript, pins: [] });
const page = { version: 1, artifacts: [{ id: "a1", title: "Page", kind: "html", versions: [{ n: 1, source: "<p>hi</p>", by: "bot", seq: 2, at: 1 }] }] };
const old = "unknown variant `room_import`, expected one of `session_load`";
/** Stand-in machines that write every call, in order, to one shared log. */
function machines() {
  const log = [];
  /** `existing`: saved files there, by path, as a leftover from an earlier move would leave. */
  const make = (name, { importError, createError, artifacts = null, saveError, existing = [] } = {}) => ({
    roomImport: async (...args) => { log.push([name, "import", ...args]); if (importError) throw new Error(importError); },
    dataFolder: async () => { log.push([name, "data folder"]); return `/d/${name}`; },
    pathsExist: async (targets) => { log.push([name, "exists", targets]); return targets.map((t) => existing.includes(t)); },
    roomCreate: async (...args) => { log.push([name, "create", ...args]); if (createError) throw new Error(createError); return snap(); },
    roomDelete: async (...args) => { log.push([name, "delete", ...args]); },
    artifactsLoad: async (...args) => { log.push([name, "artifacts", ...args]); return artifacts; },
    artifactsSave: async (...args) => { log.push([name, "save artifacts", ...args]); if (saveError) throw new Error(saveError); },
  });
  return { log, make };
}

test("to another machine: import there first, then delete the old copy", async () => {
  const { log, make } = machines();
  assert.equal(await placeThread({ from: make("mac"), to: make("at"), id: "t", snapshot: snap(), cwd: "/srv/x", sameHost: false, hostName: "AT" }), "imported");
  assert.deepEqual(log, [["at", "import", "t", snap(), "/srv/x", false], ["mac", "artifacts", "t"], ["mac", "delete", "t"]]);
});

test("to another machine: the thread's artifacts are saved there before the old copy goes", async () => {
  const { log, make } = machines();
  await placeThread({ from: make("mac", { artifacts: page }), to: make("at"), id: "t", snapshot: snap(), cwd: "/srv/x", sameHost: false, hostName: "AT" });
  assert.deepEqual(log, [["at", "import", "t", snap(), "/srv/x", false], ["mac", "artifacts", "t"], ["at", "save artifacts", "t", page], ["mac", "delete", "t"]]);
});

test("artifacts that can't be saved there undo the new copy and leave the thread where it was", async () => {
  const { log, make } = machines();
  await assert.rejects(placeThread({ from: make("mac", { artifacts: page }), to: make("at", { saveError: "disk full" }), id: "t", snapshot: snap(), cwd: "/srv/x", sameHost: false, hostName: "AT" }), /disk full/);
  assert.deepEqual(log, [["at", "import", "t", snap(), "/srv/x", false], ["mac", "artifacts", "t"], ["at", "save artifacts", "t", page], ["at", "delete", "t"]]);
});

test("to another folder on the same machine: one replace, nothing else", async () => {
  const { log, make } = machines();
  const host = make("at", { artifacts: page });
  await placeThread({ from: host, to: host, id: "t", snapshot: snap(), cwd: "/srv/y", sameHost: true, hostName: "AT" });
  assert.deepEqual(log, [["at", "import", "t", snap(), "/srv/y", true]]);
});

test("an older helper without room_import still takes a thread with no history from another machine, with its bots", async () => {
  const { log, make } = machines();
  assert.equal(await placeThread({ from: make("mac"), to: make("at", { importError: old }), id: "t", snapshot: snap(), cwd: "/srv/x", sameHost: false, hostName: "AT" }), "recreated");
  assert.deepEqual(log, [
    ["at", "import", "t", snap(), "/srv/x", false],
    ["at", "data folder"],
    ["at", "exists", ["/d/at/rooms/74.json", "/d/at/rooms/74.artifacts.json"]],
    ["at", "create", "t", [{ id: "bot" }], { policy: "mention", max_bot_hops: 3 }, "/srv/x"],
    ["mac", "artifacts", "t"],
    ["mac", "delete", "t"],
  ]);
});

// An older helper's room_create opens a saved room of the same id as it is, so
// a copy left there by an earlier move would stand in for this thread.
for (const left of ["/d/at/rooms/74.json", "/d/at/rooms/74.artifacts.json"]) {
  test(`an older helper that still has ${left.endsWith("artifacts.json") ? "artifacts" : "a saved thread"} under this id keeps it; nothing is made there or deleted anywhere`, async () => {
    const { log, make } = machines();
    const [from, to] = [make("mac", { artifacts: page }), make("at", { importError: old, saveError: "disk full", existing: [left] })];
    await assert.rejects(placeThread({ from, to, id: "t", snapshot: snap(), cwd: "/srv/x", sameHost: false, hostName: "AT" }),
      (error) => error instanceof MoveRefused && /AT/.test(error.message));
    assert.deepEqual(log.map(([machine, call]) => `${machine} ${call}`), ["at import", "at data folder", "at exists"]);
  });
}

test("a current helper that already has this id refuses the import; it's offered as New thread and nothing is deleted", async () => {
  const { log, make } = machines();
  await assert.rejects(placeThread({ from: make("mac"), to: make("at", { importError: "a thread with that id already exists" }), id: "t", snapshot: snap(), cwd: "/x", sameHost: false, hostName: "AT" }),
    (error) => error instanceof MoveRefused && /AT/.test(error.message));
  assert.deepEqual(log.map(([machine, call]) => `${machine} ${call}`), ["at import"]);
});

test("an older helper won't move a thread to another folder on its own machine; nothing is deleted or made", async () => {
  const { log, make } = machines();
  const host = make("at", { importError: old, artifacts: page });
  await assert.rejects(placeThread({ from: host, to: host, id: "t", snapshot: snap(), cwd: "/srv/y", sameHost: true, hostName: "AT" }),
    (error) => error instanceof FolderMoveUnsupported && error instanceof MoveRefused && /AT/.test(error.message));
  assert.deepEqual(log, [["at", "import", "t", snap(), "/srv/y", true]]);
});

test("history or pins can't go to an older helper; nothing is made there or deleted here", async () => {
  const { log, make } = machines();
  const [from, to] = [make("mac"), make("at", { importError: old })];
  await assert.rejects(placeThread({ from, to, id: "t", snapshot: snap([{ seq: 0 }]), cwd: "/x", sameHost: false, hostName: "AT" }), /AT's apex-daemon is too old/);
  await assert.rejects(placeThread({ from, to, id: "t", snapshot: { ...snap(), pins: ["use pnpm"] }, cwd: "/x", sameHost: false, hostName: "AT" }), /AT's apex-daemon is too old/);
  assert.deepEqual(log.map(([machine, call]) => `${machine} ${call}`), ["at import", "at import"]);
});

test("a failed import deletes nothing", async () => {
  const { log, make } = machines();
  await assert.rejects(placeThread({ from: make("mac"), to: make("at", { importError: "disk full" }), id: "t", snapshot: snap(), cwd: "/x", sameHost: false, hostName: "AT" }), /disk full/);
  assert.deepEqual(log.map(([machine, call]) => `${machine} ${call}`), ["at import"]);
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
