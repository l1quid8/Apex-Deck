import test from "node:test";
import assert from "node:assert/strict";
import { addLeaf, dividers, dropArea, edgeAt, grid, insertBeside, leafIds, mainAndStack, moveLeaf, normalize, rects, removeLeaf, resize, sync, validate } from "../src/layout.ts";

const leaf = (id) => ({ kind: "leaf", id });
const close = (a, b) => Math.abs(a - b) < 1e-9;
const rectOf = (tree, id) => rects(tree).get(id);
/** Every pane's area must tile the whole space with no gaps or overlaps. */
function assertTiles(tree) {
  const all = [...rects(tree).values()];
  const area = all.reduce((sum, r) => sum + r.w * r.h, 0);
  assert.ok(close(area, 1), `areas sum to ${area}`);
  for (const r of all) assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9);
}

test("adding panes halves the largest one across its longer side", () => {
  let tree = addLeaf(null, "a");
  assert.deepEqual(tree, leaf("a"));
  tree = addLeaf(tree, "b", 1.6);
  assert.deepEqual(tree, { kind: "split", dir: "row", children: [leaf("a"), leaf("b")], sizes: [0.5, 0.5] });
  tree = addLeaf(tree, "c", 1.6);
  // b (the later of two equal panes) is now taller than wide, so it is cut across.
  assert.deepEqual(rectOf(tree, "c"), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  tree = addLeaf(tree, "d", 1.6);
  assert.deepEqual(rectOf(tree, "d"), { x: 0, y: 0.5, w: 0.5, h: 0.5 });
  assert.deepEqual(leafIds(tree).sort(), ["a", "b", "c", "d"]);
  assertTiles(tree);
});

test("removing a pane gives its space to its neighbours and tidies the tree", () => {
  const tree = { kind: "split", dir: "row", children: [leaf("a"), { kind: "split", dir: "column", children: [leaf("b"), leaf("c")], sizes: [0.5, 0.5] }], sizes: [0.6, 0.4] };
  assert.deepEqual(removeLeaf(tree, "c"), { kind: "split", dir: "row", children: [leaf("a"), leaf("b")], sizes: [0.6, 0.4] });
  assert.deepEqual(removeLeaf(tree, "a"), { kind: "split", dir: "column", children: [leaf("b"), leaf("c")], sizes: [0.5, 0.5] });
  assert.equal(removeLeaf(leaf("a"), "a"), null);
  assert.deepEqual(removeLeaf(tree, "missing"), tree);
});

test("a split inside a split that runs the same way is folded into it", () => {
  const nested = { kind: "split", dir: "row", children: [leaf("a"), { kind: "split", dir: "row", children: [leaf("b"), leaf("c")], sizes: [0.5, 0.5] }], sizes: [0.5, 0.5] };
  assert.deepEqual(normalize(nested), { kind: "split", dir: "row", children: [leaf("a"), leaf("b"), leaf("c")], sizes: [0.5, 0.25, 0.25] });
});

test("moving a pane puts it against the chosen side, and the middle swaps", () => {
  const tree = grid(["a", "b", "c", "d"], 1.6);
  const moved = moveLeaf(tree, "a", "d", "right");
  assert.deepEqual(leafIds(moved).sort(), ["a", "b", "c", "d"]);
  const d = rectOf(moved, "d");
  const a = rectOf(moved, "a");
  assert.ok(close(a.x, d.x + d.w) && close(a.y, d.y) && close(a.h, d.h), "a sits to the right of d");
  assertTiles(moved);

  const swapped = moveLeaf(tree, "a", "d", "center");
  assert.deepEqual(rectOf(swapped, "a"), rectOf(tree, "d"));
  assert.deepEqual(rectOf(swapped, "d"), rectOf(tree, "a"));
  assert.equal(moveLeaf(tree, "a", "a", "left"), tree);
  assert.equal(moveLeaf(tree, "a", "nope", "left"), tree);
});

test("sync keeps existing panes where they are, drops the gone and adds the new", () => {
  const tree = { kind: "split", dir: "row", children: [leaf("a"), leaf("b")], sizes: [0.7, 0.3] };
  const next = sync(tree, ["a", "b", "c"]);
  assert.ok(close(rectOf(next, "b").w, 0.3), "b keeps its width");
  assert.deepEqual(leafIds(next).sort(), ["a", "b", "c"]);
  assert.deepEqual(sync(tree, ["b"]), leaf("b"));
  assert.equal(sync(tree, []), null);
  assert.deepEqual(sync(tree, ["a", "b"]), tree);
  assertTiles(next);
});

test("dragging a divider resizes only its two neighbours, within limits", () => {
  const tree = { kind: "split", dir: "row", children: [leaf("a"), leaf("b"), leaf("c")], sizes: [0.25, 0.25, 0.5] };
  const [first, second] = dividers(tree);
  assert.ok(close(first.at, 0.25) && close(second.at, 0.5));
  const wider = resize(tree, first, 0.4);
  assert.deepEqual(wider.sizes.map((s) => Math.round(s * 100)), [40, 10, 50]);
  // Cannot be pushed past its neighbour or below the minimum share.
  assert.deepEqual(resize(tree, first, 0.99).sizes.map((s) => Math.round(s * 100)), [40, 10, 50]);
  assert.deepEqual(resize(tree, first, -1).sizes.map((s) => Math.round(s * 100)), [10, 40, 50]);

  // A divider inside a nested split is measured against that split's own area.
  const nested = { kind: "split", dir: "row", children: [leaf("a"), { kind: "split", dir: "column", children: [leaf("b"), leaf("c")], sizes: [0.5, 0.5] }], sizes: [0.5, 0.5] };
  const inner = dividers(nested).find((d) => d.dir === "column");
  assert.deepEqual(inner.path, [1]);
  assert.deepEqual(inner.parent, { x: 0.5, y: 0, w: 0.5, h: 1 });
  const taller = resize(nested, inner, 0.75);
  assert.ok(close(rectOf(taller, "b").h, 0.75));
  assert.ok(close(rectOf(taller, "a").w, 0.5), "the outer split is untouched");
});

test("grids are even and choose columns to suit the window", () => {
  for (const count of [1, 2, 3, 4, 5, 6, 9]) {
    const ids = Array.from({ length: count }, (_, i) => `p${i}`);
    const tree = grid(ids, 1.6);
    assert.deepEqual(leafIds(tree), ids);
    assertTiles(tree);
  }
  const widths = (tree) => new Set([...rects(tree).values()].map((r) => r.w.toFixed(4)));
  const six = grid(["a", "b", "c", "d", "e", "f"], 1.6);
  assert.deepEqual([...widths(six)], ["0.3333"], "six panes in a wide window: three columns");
  assert.equal(new Set([...rects(six).values()].map((r) => r.h.toFixed(4))).size, 1);
  const four = grid(["a", "b", "c", "d"], 1.6);
  assert.deepEqual([...widths(four)], ["0.5000"], "four panes: two by two");
  assert.deepEqual([...widths(grid(["a", "b"], 0.6))], ["1.0000"], "a tall window stacks two panes");
  assert.equal(grid([]), null);
});

test("main and stack gives the first pane most of the room", () => {
  const top = mainAndStack(["a", "b", "c"], "top");
  assert.deepEqual(rectOf(top, "a"), { x: 0, y: 0, w: 1, h: 0.6 });
  assert.ok(close(rectOf(top, "c").x, 0.5) && close(rectOf(top, "c").h, 0.4));
  const left = mainAndStack(["a", "b", "c"], "left");
  assert.deepEqual(rectOf(left, "a"), { x: 0, y: 0, w: 0.6, h: 1 });
  assert.deepEqual(mainAndStack(["a"], "left"), leaf("a"));
});

test("drop zones: the middle swaps, otherwise the nearest side wins", () => {
  const r = { x: 0.5, y: 0, w: 0.5, h: 1 };
  assert.equal(edgeAt(r, 0.75, 0.5), "center");
  assert.equal(edgeAt(r, 0.52, 0.5), "left");
  assert.equal(edgeAt(r, 0.98, 0.5), "right");
  assert.equal(edgeAt(r, 0.75, 0.05), "top");
  assert.equal(edgeAt(r, 0.75, 0.95), "bottom");
  assert.deepEqual(dropArea(r, "right"), { x: 0.75, y: 0, w: 0.25, h: 1 });
  assert.deepEqual(dropArea(r, "top"), { x: 0.5, y: 0, w: 0.5, h: 0.5 });
  assert.deepEqual(dropArea(r, "center"), r);
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
  assert.deepEqual(insertBeside(leaf("a"), "a", "b", "top"), { kind: "split", dir: "column", children: [leaf("b"), leaf("a")], sizes: [0.5, 0.5] });
});
