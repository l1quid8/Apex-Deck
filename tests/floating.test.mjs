import test from "node:test";
import assert from "node:assert/strict";
import { aboveAnchor, popoverTop } from "../src/floating.ts";

const window = { width: 1200, height: 800 };

test("a card opens above its badge, in line with it", () => {
  assert.deepEqual(aboveAnchor({ left: 100, top: 700 }, window, 340), { left: 100, bottom: 106 });
  assert.deepEqual(aboveAnchor({ left: 100, top: 700 }, window, 330, 8), { left: 100, bottom: 108 });
});

test("a card by the right edge moves left to stay on screen", () => {
  assert.equal(aboveAnchor({ left: 1000, top: 700 }, window, 340).left, 852);
});

test("a card wider than the window keeps its left edge on screen", () => {
  assert.equal(aboveAnchor({ left: 50, top: 700 }, { width: 300, height: 800 }, 340).left, 8);
});

test("bot settings open below the badge when there is room", () => {
  assert.equal(popoverTop({ top: 100, bottom: 130 }, 300, 800), 136);
});

test("bot settings open above a badge at the bottom of the window", () => {
  assert.equal(popoverTop({ top: 700, bottom: 730 }, 300, 800), 394);
});

test("bot settings taller than the room on either side stay on screen", () => {
  assert.equal(popoverTop({ top: 200, bottom: 230 }, 700, 800), 8);
});
