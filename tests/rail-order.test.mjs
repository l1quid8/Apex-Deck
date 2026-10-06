import test from "node:test";
import assert from "node:assert/strict";
import { pinnedFirst } from "../src/railOrder.ts";

test("pinned rows stay first and the others keep their order", () => {
  const panes = [
    { id: "a" },
    { id: "b", pinned: true },
    { id: "c", pinned: false },
    { id: "d", pinned: true },
  ];
  assert.deepEqual(pinnedFirst(panes).map((p) => p.id), ["b", "d", "a", "c"]);
});
