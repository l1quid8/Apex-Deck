import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLANK, GHOST, TINT, batteryCells, bindingWindow, contextLevel, contextLine, hasReset, isCritical, isLow,
  mergePlan, planLevel, planLine, refillDelay, rowFill, shellState, windowLabel,
} from '../src/battery.ts';

/** A pattern with every cell lit, so each cell shows its fill. */
const solid = Array.from({ length: 25 }, (_, i) => ({ on: true, wave: Math.floor(i / 5) + (i % 5) }));
const empty = solid.map((c) => ({ ...c, on: false }));
const at = (cells, row, col) => cells[row * 5 + col];
const win = (name, used, minutes = null, resets = null) => ({ name, used_percent: used, window_minutes: minutes, resets_at: resets });

test('each side drains from the top, one row per fifth', () => {
  // fill = clamp(level × 5 − rowsFromBottom, 0, 1); row 4 is the bottom.
  assert.deepEqual([0, 1, 2, 3, 4].map((row) => rowFill(1, row)), [1, 1, 1, 1, 1]);
  assert.deepEqual([0, 1, 2, 3, 4].map((row) => rowFill(0.6, row)), [0, 0, 1, 1, 1]);
  assert.deepEqual([0, 1, 2, 3, 4].map((row) => rowFill(0, row)), [0, 0, 0, 0, 0]);
  const partial = rowFill(0.5, 2);
  assert.ok(Math.abs(partial - 0.5) < 1e-9, `${partial}`);
});

test('the left two columns show context, the right two the plan, and the middle the lower of the two', () => {
  const cells = batteryCells(solid, { context: 0.2, plan: 0.8 });
  for (let row = 0; row < 5; row++) {
    assert.equal(at(cells, row, 0).fill, rowFill(0.2, row));
    assert.equal(at(cells, row, 1).fill, rowFill(0.2, row));
    assert.equal(at(cells, row, 3).fill, rowFill(0.8, row));
    assert.equal(at(cells, row, 4).fill, rowFill(0.8, row));
    assert.equal(at(cells, row, 2).fill, rowFill(0.2, row), 'middle follows the lower side');
  }
  const flipped = batteryCells(solid, { context: 0.9, plan: 0.4 });
  assert.equal(at(flipped, 2, 2).fill, rowFill(0.4, 2));
  assert.deepEqual([0, 1, 2, 3, 4].map((c) => at(cells, 0, c).side), ['context', 'context', 'both', 'plan', 'plan']);
});

test('lit cells are full, partly filled, or a faint ghost; unlit cells are tinted only below the level', () => {
  const cells = batteryCells(solid, { context: 0.5, plan: 1 });
  assert.equal(at(cells, 4, 0).alpha, 1, 'full row');
  const partly = at(cells, 2, 0).alpha;
  assert.ok(partly > 0.3 && partly < 1, `half row draws between 30% and 100%: ${partly}`);
  assert.equal(at(cells, 0, 0).alpha, GHOST, 'drained lit cell stays a ghost');
  const unlit = batteryCells(empty, { context: 0.5, plan: 1 });
  assert.equal(at(unlit, 4, 0).alpha, TINT);
  assert.equal(at(unlit, 0, 0).alpha, BLANK);
  assert.ok(BLANK < TINT && TINT < GHOST);
});

test('partial fills scale from 30% to 100%', () => {
  const nearlyEmpty = batteryCells(solid, { context: 0.802, plan: 1 });
  const top = at(nearlyEmpty, 0, 0);
  assert.ok(top.fill > 0 && top.fill < 0.05);
  assert.ok(Math.abs(top.alpha - (0.3 + 0.7 * top.fill)) < 1e-9);
});

test('unknown sides draw full and show no warning', () => {
  const cells = batteryCells(solid, { context: null, plan: null });
  assert.ok(cells.every((c) => c.fill === 1 && c.alpha === 1));
  assert.equal(shellState({ context: null, plan: null }), 'ok');
  // Only the known side drains; the middle takes the lower of a known and a full side.
  const half = batteryCells(solid, { context: null, plan: 0.2 });
  assert.equal(at(half, 0, 0).fill, 1);
  assert.equal(at(half, 0, 2).fill, 0);
  assert.equal(contextLevel(undefined), null);
  assert.equal(contextLevel({ used: 10, window: 0 }), null);
  assert.equal(planLevel(undefined, 0), null);
  assert.equal(planLevel([], 0), null);
});

test('a low side keeps the agent colour: at or under 20% the shell reads low, at or under 8% critical', () => {
  assert.ok(isLow(0.2) && isLow(0.1) && !isLow(0.21) && !isLow(null));
  assert.ok(isCritical(0.08) && !isCritical(0.09) && !isCritical(null));
  const low = batteryCells(solid, { context: 0.18, plan: 0.9 });
  assert.ok(low.every((cell) => !('red' in cell)), 'no cell is drawn in another colour');
  assert.ok(at(low, 4, 0).alpha > 0.9, 'charge on the low side draws at near full strength');
  assert.equal(shellState({ context: 0.18, plan: 0.9 }), 'low');
  assert.equal(shellState({ context: 0.9, plan: 0.05 }), 'critical');
  assert.equal(shellState({ context: 0.5, plan: 0.5 }), 'ok');
});

test('context left comes from the latest request against the window', () => {
  assert.equal(contextLevel({ used: 164_000, window: 200_000 }), 0.18000000000000005);
  assert.equal(contextLevel({ used: 250_000, window: 200_000 }), 0);
  assert.equal(contextLine({ used: 164_000, window: 200_000 }), '18% left · 36k of 200k tokens');
});

test('plan left is 100 minus the most used window, and a window that has reset no longer counts', () => {
  const windows = [win('five_hour', 70, 300, 2_000), win('seven_day', 19, 10_080, 9_000)];
  assert.equal(bindingWindow(windows, 1_000).name, 'five_hour');
  assert.ok(Math.abs(planLevel(windows, 1_000) - 0.3) < 1e-9);
  // Past its reset the 5-hour figure is stale, so the weekly one binds.
  assert.ok(Math.abs(planLevel(windows, 2_500) - 0.81) < 1e-9);
  assert.equal(planLevel(windows, 9_500), null, 'both windows have reset by then');
  assert.equal(planLevel([win('primary', 15, 10_080, null)], 1e12), 0.85);
});

test('plan lines name the binding window and the others', () => {
  const now = new Date(2026, 9, 3, 12, 0, 0);
  const at3 = new Date(2026, 9, 3, 15, 0, 0).getTime() / 1000;
  const later = new Date(2026, 9, 6, 9, 0, 0).getTime() / 1000;
  const line = planLine([win('five_hour', 36, 300, at3), win('seven_day', 19, 10_080, later)], now);
  assert.match(line, /^64% left · resets 3:00\s?PM · weekly 81%$/);
  assert.equal(planLine([], now), null);
  assert.equal(windowLabel(win('five_hour', 0, 300)), '5-hour');
  assert.equal(windowLabel(win('primary', 0, 10_080)), 'weekly');
  assert.equal(windowLabel(win('seven_day_opus', 0, null)), 'seven day opus');
});

test('partial plan reports change only the windows they list', () => {
  const known = [win('primary', 40, 300, 10), win('secondary', 20, 10_080, 99)];
  assert.deepEqual(mergePlan(known, [win('primary', 45, 300, 10)], true), [win('primary', 45, 300, 10), win('secondary', 20, 10_080, 99)]);
  assert.deepEqual(mergePlan(known, [win('primary', 45, 300, 10)], false), [win('primary', 45, 300, 10)]);
  assert.deepEqual(mergePlan(undefined, [win('primary', 1)], true), [win('primary', 1)]);
});

test('a window that starts over is a reset, a busier one is not', () => {
  const known = [win('five_hour', 90, 300, 1_000)];
  assert.ok(hasReset(known, [win('five_hour', 2, 300, 19_000)]));
  assert.ok(!hasReset(known, [win('five_hour', 91, 300, 1_000)]));
  assert.ok(!hasReset(undefined, [win('five_hour', 2, 300, 19_000)]));
});

test('refills run bottom row first, 140ms apart', () => {
  assert.deepEqual([4, 3, 2, 1, 0].map(refillDelay), [0, 140, 280, 420, 560]);
});

test('battery styles never borrow the danger colour or pulse', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const rules = css.split('}').filter((rule) => rule.includes('.identicon'));
  assert.ok(rules.length > 0);
  for (const rule of rules) assert.ok(!rule.includes('--danger'), rule.trim());
  assert.ok(!css.includes('battery-critical'), 'no pulsing keyframes');
});
