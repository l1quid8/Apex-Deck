import test from "node:test";
import assert from "node:assert/strict";
import {
  SEQUENCE, WAKE_MAX, TAP_MAX, createFieldState, shapeReach, wakeForce,
  pointerMove, pointerTap, prune, frontRadius, gridSize, rainbowHue,
  hexToRgb, glowMix, frameIntervalMs, idleVisibility,
} from "../src/landing/engine.ts";
import { DEFAULT_LANDING_TEXTURE, readLandingTexture, readSettings } from "../src/settings.ts";

test("glyph sequence is 42 chars", () => {
  assert.equal(SEQUENCE.length, 42);
});

test("shapeReach: circle is radial, diamond is Manhattan", () => {
  assert.equal(shapeReach(10, 0, "circle"), 10);
  assert.equal(shapeReach(10, 0, "diamond"), 10);
  assert.equal(shapeReach(0, -7, "diamond"), 7);
  // At 45 degrees the diamond reach is d * sqrt(2).
  const d = Math.hypot(10, 10);
  assert.ok(Math.abs(shapeReach(10, 10, "diamond") - d * Math.SQRT2) < 1e-9);
  assert.ok(Math.abs(shapeReach(3, 4, "circle") - 5) < 1e-9);
});

test("wakeForce: slow drift does nothing, fast saturates", () => {
  assert.equal(wakeForce(0, 100), 0);
  assert.equal(wakeForce(60, 100), 0);
  assert.ok(wakeForce(800, 1e9) > 0.999);
  assert.ok(wakeForce(400, 100) > 0 && wakeForce(400, 100) < 1);
  assert.equal(wakeForce(Number.NaN, 100), 0);
  assert.equal(wakeForce(800, 0), 0);
});

test("pointerMove: emission needs 18px and 35ms, ring capped at 48", () => {
  const s = createFieldState(0);
  pointerMove(s, 0, 0, 0);
  assert.equal(pointerMove(s, 10, 0, 0.05), null); // too short
  assert.equal(pointerMove(s, 30, 0, 0.06) === null || s.wakes.length <= 1, true);
  // Fast sustained sweep: 60px every 40ms = 1500 px/s.
  let t = 0.1;
  for (let i = 0; i < 80; i++) { t += 0.04; pointerMove(s, 30 + i * 60, 0, t); }
  assert.ok(s.wakes.length > 0);
  assert.ok(s.wakes.length <= WAKE_MAX);
});

test("pointerMove: touch never warms", () => {
  const s = createFieldState(0);
  pointerMove(s, 0, 0, 0, "touch");
  pointerMove(s, 500, 0, 0.1, "touch");
  assert.equal(s.wakes.length, 0);
});

test("pointerTap: every 3rd tap is shaped, buffer capped at 6", () => {
  const s = createFieldState(0);
  const shapes = [];
  for (let i = 0; i < 7; i++) shapes.push(pointerTap(s, 0, 0, i * 0.1, "diamond").shape);
  assert.deepEqual(shapes, ["circle", "circle", "diamond", "circle", "circle", "diamond", "circle"]);
  assert.equal(s.taps.length, TAP_MAX);
  const c = createFieldState(0);
  assert.equal(pointerTap(c, 0, 0, 0, "circle").shape, "circle");
  pointerTap(c, 0, 0, 0.1, "circle");
  assert.equal(pointerTap(c, 0, 0, 0.2, "circle").shape, "circle");
});

test("front radius starts at 0 and asymptotes to 620", () => {
  assert.equal(frontRadius(0), 0);
  assert.ok(frontRadius(1.3) > 380 && frontRadius(1.3) < 400);
  assert.ok(frontRadius(20) < 620 && frontRadius(20) > 619.9);
});

test("prune expires wakes at 2.4s and taps at 3.6s", () => {
  const s = createFieldState(0);
  s.wakes.push({ x: 0, y: 0, dx: 1, dy: 0, len: 5, force: 1, at: 0 });
  s.taps.push({ x: 0, y: 0, at: 0, shape: "circle" });
  prune(s, 2.39);
  assert.equal(s.wakes.length, 1);
  prune(s, 2.4);
  assert.equal(s.wakes.length, 0);
  assert.equal(s.taps.length, 1);
  prune(s, 3.6);
  assert.equal(s.taps.length, 0);
});

test("grid sizing uses 6.5x13 cells", () => {
  assert.deepEqual(gridSize(650, 130), { cols: 100, rows: 10 });
  assert.deepEqual(gridSize(0, 0), { cols: 0, rows: 0 });
});

test("rainbow hue wraps and speed 0 freezes it", () => {
  for (const t of [0, 1, 100, 10000]) {
    const h = rainbowHue(123, 45, t, 1);
    assert.ok(h >= 0 && h < 360);
  }
  assert.equal(rainbowHue(10, 10, 0, 0), rainbowHue(10, 10, 999, 0));
});

test("hex and glow color math stay in gamut", () => {
  assert.deepEqual(hexToRgb("#3def91"), [0x3d / 255, 0xef / 255, 0x91 / 255]);
  assert.deepEqual(hexToRgb("#fff"), [1, 1, 1]);
  assert.equal(hexToRgb("mint"), null);
  assert.equal(hexToRgb("#12345"), null);
  for (const v of glowMix([0, 0, 0], 1)) assert.ok(v >= 0 && v <= 1);
  assert.deepEqual(glowMix([0.2, 0.4, 0.6], 0), [0.2, 0.4, 0.6]);
});

test("frame intervals and settle", () => {
  const s = createFieldState(0);
  assert.equal(frameIntervalMs(s, 0), 40);
  pointerTap(s, 0, 0, 0, "diamond");
  assert.equal(frameIntervalMs(s, 0), 10);
  prune(s, 200);
  assert.equal(frameIntervalMs(s, 200), 83);
  assert.equal(idleVisibility(s, 100), 1);
  assert.ok(idleVisibility(s, 184) > 0 && idleVisibility(s, 184) < 1);
  assert.equal(idleVisibility(s, 300), 0);
});

test("landing settings round-trip and corrupt per-field", () => {
  const good = { enabled: false, mode: "single", color: "#AABBCC", rainbowSpeed: 2.5, rippleShape: "circle" };
  assert.deepEqual(readLandingTexture(good), { ...good, color: "#aabbcc" });
  assert.deepEqual(readLandingTexture(null), DEFAULT_LANDING_TEXTURE);
  const bad = readLandingTexture({ enabled: "yes", mode: "plaid", color: "mint", rainbowSpeed: Number.NaN, rippleShape: "heart" });
  assert.deepEqual(bad, DEFAULT_LANDING_TEXTURE);
  assert.equal(readLandingTexture({ rainbowSpeed: 99 }).rainbowSpeed, 3);
  assert.equal(readLandingTexture({ rainbowSpeed: -1 }).rainbowSpeed, 0);
});

test("readSettings keeps the rest of the file when landing texture is corrupt", () => {
  const read = readSettings({
    newBotAccess: "ask",
    landingTexture: { mode: "plaid", color: "#12xx56", rainbowSpeed: "fast" },
  });
  assert.equal(read.newBotAccess, "ask");
  assert.deepEqual(read.landingTexture, DEFAULT_LANDING_TEXTURE);
  // Older files without the field stay without it.
  assert.equal(readSettings({}).landingTexture, undefined);
});
