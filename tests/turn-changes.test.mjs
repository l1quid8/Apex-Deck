import test from "node:test";
import assert from "node:assert/strict";
import { turnFilesFor } from "../src/turnChanges.ts";

const human = (seq, text = "hi") => ({ seq, speaker: { kind: "human" }, text });
const bot = (seq, id, text = "done") => ({ seq, speaker: { kind: "bot", id }, text });
const change = (seq, by, path, added = 1, removed = 0) => ({
  seq,
  by,
  change: { path, diff: "", added, removed },
});

test("changes attach to the next reply from the same author", () => {
  const messages = [human(0), bot(1, "opus"), human(2), bot(3, "opus")];
  const changes = [change(0, "opus", "src/a.ts", 10, 2), change(2, "opus", "src/b.ts", 5, 1)];
  const out = turnFilesFor(messages, changes);
  assert.deepEqual(out.get(1), [{ path: "src/a.ts", added: 10, removed: 2 }]);
  assert.deepEqual(out.get(3), [{ path: "src/b.ts", added: 5, removed: 1 }]);
});

test("the strip is model-agnostic: any author gets the same grouping", () => {
  const messages = [human(0), bot(1, "sol-1-large"), bot(2, "opus")];
  const changes = [change(0, "sol-1-large", "src/a.ts", 3, 0), change(0, "opus", "src/b.ts", 4, 1)];
  const out = turnFilesFor(messages, changes);
  assert.deepEqual(out.get(1), [{ path: "src/a.ts", added: 3, removed: 0 }]);
  assert.deepEqual(out.get(2), [{ path: "src/b.ts", added: 4, removed: 1 }]);
});

test("edits to the same path in one turn sum, and a turn with no changes has no card", () => {
  const messages = [human(0), bot(1, "opus"), bot(2, "jigga")];
  const changes = [
    change(0, "opus", "src/a.ts", 10, 2),
    change(0, "opus", "src/a.ts", 5, 1),
    change(0, "opus", "src/b.ts", 1, 0),
  ];
  const out = turnFilesFor(messages, changes);
  assert.deepEqual(out.get(1), [
    { path: "src/a.ts", added: 15, removed: 3 },
    { path: "src/b.ts", added: 1, removed: 0 },
  ]);
  assert.equal(out.has(2), false);
});

test("changes still waiting on their reply (no later message yet) are dropped", () => {
  const messages = [human(0), bot(1, "opus")];
  const changes = [change(2, "opus", "src/late.ts")];
  const out = turnFilesFor(messages, changes);
  assert.equal(out.size, 0);
});
