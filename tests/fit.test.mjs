import test from "node:test";
import assert from "node:assert/strict";
import { fitHeight, fitSteps } from "../src/fit.ts";

/** A row whose width depends on the step applied to it, in `room` pixels of space. */
const fitRow = (room, widths) => {
  const row = { step: null };
  const kept = fitSteps(Object.keys(widths), (step) => { row.step = step; }, () => widths[row.step] <= room);
  return { kept, applied: row.step };
};

test("a row keeps the most detail that fits", () => {
  const widths = { full: 600, levels: 450, names: 300, faces: 120 };
  assert.deepEqual(fitRow(700, widths), { kept: "full", applied: "full" });
  assert.deepEqual(fitRow(460, widths), { kept: "levels", applied: "levels" });
  assert.deepEqual(fitRow(200, widths), { kept: "faces", applied: "faces" });
});

test("when nothing fits, the last step stays applied", () => {
  assert.deepEqual(fitRow(50, { full: 600, faces: 120 }), { kept: "faces", applied: "faces" });
});

test("steps are tried in order and stop at the first that fits", () => {
  const tried = [];
  fitSteps(["full", "levels", "names"], (step) => tried.push(step), () => tried.at(-1) === "levels");
  assert.deepEqual(tried, ["full", "levels"]);
});

/** A message box with the sizes the browser reports; hidden, it reports all zeros. */
const textBox = ({ shown, lines }) => {
  const box = { style: { height: "" } };
  const sized = () => (box.style.height === "auto" ? 16 + lines * 20 : parseInt(box.style.height, 10) || 36);
  Object.defineProperties(box, {
    clientWidth: { get: () => (shown ? 600 : 0) },
    clientHeight: { get: () => (shown ? sized() : 0) },
    offsetHeight: { get: () => (shown ? sized() : 0) },
    scrollHeight: { get: () => (shown ? 16 + lines * 20 : 0) },
  });
  return box;
};

test("a message box grows to fit its text", () => {
  const box = textBox({ shown: true, lines: 3 });
  fitHeight(box);
  assert.equal(box.style.height, "76px");
});

test("a hidden message box keeps its height instead of shrinking to nothing", () => {
  const box = textBox({ shown: false, lines: 1 });
  fitHeight(box);
  assert.equal(box.style.height, "");
});
