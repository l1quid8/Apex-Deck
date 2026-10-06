import test from "node:test";
import assert from "node:assert/strict";
import { lastReply, folderCopyText, writeClipboard, COPIED } from "../src/threadCopy.ts";
import { threadStatusOf } from "../src/composerStatus.ts";

const msg = (seq, speaker, text) => ({ seq, speaker, text });

test("the last reply is the newest bot message, not yours", () => {
  const t = [msg(1, { kind: "human" }, "hi"), msg(2, { kind: "bot", id: "a" }, "first"), msg(3, { kind: "bot", id: "b" }, "second"), msg(4, { kind: "human" }, "thanks")];
  assert.equal(lastReply(t), "second");
  assert.equal(lastReply([msg(1, { kind: "human" }, "hi")]), "");
});

test("a server folder copies with its SSH destination; a Mac folder copies as is", () => {
  assert.equal(folderCopyText("/root/apex-deck", "root@hetzner-eu"), "root@hetzner-eu:/root/apex-deck");
  assert.equal(folderCopyText("/Users/t/apex-deck"), "/Users/t/apex-deck");
  assert.equal(folderCopyText("", "root@hetzner-eu"), "");
});

test("a clipboard that refuses, or none at all, means nothing was copied", async () => {
  const seen = [];
  assert.equal(await writeClipboard("x", { writeText: async (t) => { seen.push(t); } }), true);
  assert.deepEqual(seen, ["x"]);
  assert.equal(await writeClipboard("x", { writeText: async () => { throw new Error("denied"); } }), false);
  assert.equal(await writeClipboard("x", undefined), false);
  assert.equal(COPIED.markdown, "the thread as Markdown");
  assert.equal(COPIED.path, "the folder path");
});

test("a thread's status names who is in it", () => {
  const s = threadStatusOf([{ id: "a", display_name: "Jigga" }, { id: "b", display_name: "Codex" }], [], []);
  assert.deepEqual(s.who, ["Jigga", "Codex"]);
});
