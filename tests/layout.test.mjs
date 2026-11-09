import test from "node:test";
import assert from "node:assert/strict";
import { leafIds, normalize, validate } from "../src/layout.ts";

const leaf = (id) => ({ kind: "leaf", id });
test("a split inside a split that runs the same way is folded into it", () => {
  const nested = { kind: "split", dir: "row", children: [leaf("a"), { kind: "split", dir: "row", children: [leaf("b"), leaf("c")], sizes: [0.5, 0.5] }], sizes: [0.5, 0.5] };
  assert.deepEqual(normalize(nested), { kind: "split", dir: "row", children: [leaf("a"), leaf("b"), leaf("c")], sizes: [0.5, 0.25, 0.25] });
});

test("saved layouts are checked before use", () => {
  const good = { kind: "split", dir: "row", children: [leaf("a"), leaf("b")], sizes: [2, 1] };
  assert.deepEqual(validate(good), { kind: "split", dir: "row", children: [leaf("a"), leaf("b")], sizes: [2 / 3, 1 / 3] });
  assert.deepEqual(validate(leaf("a")), leaf("a"));
  for (const bad of [
    null,
    "x",
    { kind: "leaf" },
    { kind: "split", dir: "diagonal", children: [leaf("a")], sizes: [1] },
    { kind: "split", dir: "row", children: [leaf("a"), leaf("b")], sizes: [1] },
    { kind: "split", dir: "row", children: [leaf("a"), leaf("b")], sizes: [1, -1] },
    { kind: "split", dir: "row", children: [leaf("a"), { kind: "what" }], sizes: [1, 1] },
    { kind: "split", dir: "row", children: [leaf("a"), leaf("a")], sizes: [1, 1] },
  ]) {
    assert.equal(validate(bad), null, JSON.stringify(bad));
  }
});

test("migration preserves reading order and normalizes empty or one-pane splits", () => {
  const nested = { kind: "split", dir: "row", children: [leaf("a"), { kind: "split", dir: "column", children: [leaf("b"), leaf("c")], sizes: [2, 3] }], sizes: [2, 4] };
  assert.deepEqual(leafIds(validate(nested)), ["a", "b", "c"]);
  assert.deepEqual(leafIds(null), []);
  assert.deepEqual(validate({ kind: "split", dir: "row", children: [leaf("a")], sizes: [5] }), leaf("a"));
  assert.equal(validate({ kind: "split", dir: "row", children: [], sizes: [] }), null);
  assert.equal(normalize(null), null);
  assert.equal(normalize({ kind: "split", dir: "row", children: [], sizes: [] }), null);
});
