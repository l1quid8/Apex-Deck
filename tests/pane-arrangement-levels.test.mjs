import test from 'node:test'; import assert from 'node:assert/strict';
import { gridLevels, bandLevels, defaultLevel, levelIndex, zoomRange } from '../src/paneArrangement.ts';
const shape = (ls) => ls.map((l) => `${l.cols}x${l.rows}`).join(' ');
test('grid: 14 panes in 1200×800 step from all-fit down to one pane', () => {
  const ls = gridLevels(14, { w: 1200, h: 800 });
  assert.equal(shape(ls), '4x4 4x3 3x3 3x2 2x2 2x1 1x1');
  assert.equal(defaultLevel(ls, 1200), 1);            // 4x3 = 294×261, the most panes ≥ 280×200
});
test('grid: narrow area', () => {
  const ls = gridLevels(14, { w: 530, h: 414 });
  assert.equal(shape(ls), '4x4 3x4 3x3 2x4 2x3 2x2 1x2 1x1');
  assert.equal(defaultLevel(ls, 530), 6);
});
test('grid: few panes all fit comfortably', () => {
  const ls = gridLevels(5, { w: 1200, h: 800 });
  assert.equal(shape(ls), '3x2 2x2 2x1 1x1'); assert.equal(defaultLevel(ls, 1200), 0);
});
test('bands: rows ≥ 56, columns ≥ 120, down to one', () => {
  const h = bandLevels(14, { w: 1200, h: 800 }, 'horizontal');
  assert.equal(h.length, 12); assert.equal(h[0].rows, 12); assert.equal(h.at(-1).rows, 1); assert.equal(defaultLevel(h, 1200), 9);
  const v = bandLevels(14, { w: 1200, h: 800 }, 'vertical');
  assert.equal(v.length, 9); assert.equal(v[0].cols, 9); assert.equal(defaultLevel(v, 1200), 5);
});
test('every level fills the area exactly; columns never come back; ends at 1x1', () => {
  for (const [n, w, h] of [[14, 1200, 800], [7, 900, 600], [30, 1512, 880], [2, 600, 400]]) {
    const ls = gridLevels(n, { w, h });
    for (const l of ls) {
      assert.ok(Math.abs(l.cols * l.w + (l.cols - 1) * 8 - w) < 0.01);
      assert.ok(Math.abs(l.rows * l.h + (l.rows - 1) * 8 - h) < 0.01);
    }
    ls.slice(1).forEach((l, i) => { assert.ok(l.cols <= ls[i].cols); assert.ok(l.shown < ls[i].shown); });
    assert.equal(shape(ls.slice(-1)), '1x1');
  }
});
test('more panes than fit: start from the densest grid of live-size panes, never throw', () => {
  // The mockup's flatLevels throws a TypeError for all three of these.
  const ls = gridLevels(64, { w: 530, h: 414 });
  assert.equal(shape(ls), '4x6 4x5 3x6 3x5 3x4 3x3 2x4 2x3 2x2 1x2 1x1');
  assert.equal(ls[0].shown, 24); assert.equal(defaultLevel(ls, 530), 9);
  for (const n of [100, 200]) assert.equal(shape(gridLevels(n, { w: 530, h: 414 })), shape(ls));
  assert.equal(shape(gridLevels(300, { w: 1100, h: 650 }).slice(0, 2)), '8x10 8x9');
});
test('no panes or no area gives no levels; an area smaller than one pane gives one', () => {
  assert.deepEqual(gridLevels(0, { w: 1200, h: 800 }), []);
  assert.deepEqual(gridLevels(14, { w: 0, h: 400 }), []);
  assert.deepEqual(bandLevels(0, { w: 1200, h: 800 }, 'vertical'), []);
  assert.equal(defaultLevel([], 1200), -1);
  assert.equal(shape(gridLevels(14, { w: 100, h: 50 })), '1x1');
});
test('sweep: every count and size keeps the rules', () => {
  for (const n of [1, 2, 3, 14, 48, 63, 64, 100, 200, 500, 5000]) {
    for (const [w, h] of [[1512, 880], [1200, 800], [1100, 650], [530, 414], [300, 200], [119, 55], [1, 1]]) {
      const ls = gridLevels(n, { w, h });
      assert.ok(ls.length > 0); assert.equal(shape(ls.slice(-1)), '1x1');
      ls.forEach((l, i) => {
        assert.ok(l.cols === 1 || l.w >= 120); assert.ok(l.rows === 1 || l.h >= 56);
        if (i) { assert.ok(l.cols <= ls[i - 1].cols); assert.ok(l.shown < ls[i - 1].shown); }
      });
      const d = defaultLevel(ls, w); assert.ok(d >= 0 && d < ls.length);
    }
  }
});

test('zoom ratios round-trip every level and stay at the ends', () => {
  for (const levels of [gridLevels(14, { w: 1200, h: 800 }), bandLevels(14, { w: 530, h: 414 }, 'vertical')]) {
    const d = defaultLevel(levels, 1200);
    levels.forEach((level, i) => assert.equal(levelIndex(levels, d, levels[d].shown / level.shown), i));
    const [lo, hi] = zoomRange(levels, d);
    assert.equal(levelIndex(levels, d, lo / 10), 0);
    assert.equal(levelIndex(levels, d, hi * 10), levels.length - 1);
    for (const zoom of [0, -1, NaN, Infinity]) assert.equal(levelIndex(levels, d, zoom), d);
  }
  assert.equal(levelIndex([], -1, 1), -1);
  assert.deepEqual(zoomRange([], -1), [1, 1]);
  for (const area of [{ w: NaN, h: 400 }, { w: 800, h: Infinity }, { w: -1, h: 400 }]) {
    assert.deepEqual(gridLevels(14, area), []);
    assert.deepEqual(bandLevels(14, area, 'horizontal'), []);
  }
});

