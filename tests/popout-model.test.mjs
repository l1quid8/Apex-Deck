import test from "node:test";
import assert from "node:assert/strict";
import { addLeaf, leafIds } from "../src/layout.ts";
import { restorePane, restoreTab, takePaneOut, takeTabOut } from "../src/popoutModel.ts";
import { defaultPanel, openTab } from "../src/rightPanelModel.ts";

test("taking a pane out remembers a neighbour and restores beside it", () => {
  let tree = addLeaf(null, "a");
  tree = addLeaf(tree, "b", 1.6);
  tree = addLeaf(tree, "c", 1.6);
  const out = takePaneOut(tree, "w1", "b");
  assert.deepEqual(leafIds(out.layout).sort(), ["a", "c"]);
  assert.ok(out.spot.neighborId === "a" || out.spot.neighborId === "c");
  const back = restorePane(out.layout, "b", out.spot);
  assert.deepEqual(leafIds(back).sort(), ["a", "b", "c"]);
});

test("restoring falls back when the neighbour is gone", () => {
  let tree = addLeaf(null, "a");
  tree = addLeaf(tree, "b", 1.6);
  const out = takePaneOut(tree, "w1", "a");
  assert.equal(out.spot.neighborId, "b");
  // Neighbour closed meanwhile: only c remains.
  let current = addLeaf(null, "c");
  const back = restorePane(current, "a", out.spot);
  assert.deepEqual(leafIds(back).sort(), ["a", "c"]);
});

test("restoring into an empty layout makes a lone leaf", () => {
  const out = takePaneOut(addLeaf(null, "a"), "w1", "a");
  assert.equal(out.layout, null);
  assert.equal(out.spot.neighborId, null);
  assert.deepEqual(restorePane(out.layout, "a", out.spot), { kind: "leaf", id: "a" });
});

test("restoring a pane that is already back changes nothing", () => {
  const tree = addLeaf(addLeaf(null, "a"), "b", 1.6);
  const out = takePaneOut(tree, "w1", "missing");
  assert.deepEqual(out.layout, tree);
});

test("tabs remember their strip index and come back there", () => {
  let panel = defaultPanel();
  panel = openTab(panel, "files", 1);
  panel = openTab(panel, "worktrees", 2);
  const out = takeTabOut(panel, "files");
  assert.ok(out);
  assert.ok(!out.panel.tabs.some((t) => t.id === "files"));
  const back = restoreTab(out.panel, out.tab, out.spot);
  assert.deepEqual(back.tabs.map((t) => t.id), panel.tabs.map((t) => t.id));
});

test("a tab restored after its slot moved is clamped, not lost", () => {
  let panel = defaultPanel();
  panel = openTab(panel, "files", 1);
  const out = takeTabOut(panel, "files");
  assert.ok(out);
  // Meanwhile every closable tab closed: only fixed remain.
  const stripped = { ...out.panel, tabs: out.panel.tabs.filter((t) => ["dashboard", "tasks"].includes(t.kind)) };
  const back = restoreTab(stripped, out.tab, { index: 99, active: "missing" });
  assert.ok(back.tabs.some((t) => t.id === "files"));
  assert.equal(back.active, "files");
});

test("taking out a missing tab returns null", () => {
  assert.equal(takeTabOut(defaultPanel(), "nope"), null);
});
