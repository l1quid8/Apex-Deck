import test from 'node:test'; import assert from 'node:assert/strict';
import { place, arrangementFromSaved, validArrangement } from '../src/paneArrangement.ts';
const ids = Array.from({ length: 14 }, (_, i) => `p${i}`); const A = { w: 1200, h: 800 }; const H = 784 / 3;
const arr = (mode, x = {}) => ({ mode, order: ids, zoom: 1, focusShare: 0.58, ...x });
test('Even grid: 4×3 on screen; the short last row widens', () => {
  const p = place(arr('grid'), A);
  assert.deepEqual(p.rects.get('p0'), { x: 0, y: 0, w: 294, h: H });
  assert.deepEqual(p.rects.get('p13'), { x: 604, y: 3 * (H + 8), w: 596, h: H });
  assert.equal(p.axis, 'y'); assert.deepEqual(p.snaps.slice(0, 2), [0, H + 8]);
});
test('Horizontal: full-width rows, three on screen', () => {
  const p = place(arr('horizontal'), A);
  assert.deepEqual(p.rects.get('p1'), { x: 0, y: H + 8, w: 1200, h: H });
  assert.equal(p.world.h, 14 * H + 13 * 8);
});
test('Vertical: full-height columns, four on screen, sideways', () => {
  const p = place(arr('vertical'), A);
  assert.deepEqual(p.rects.get('p1'), { x: 302, y: 0, w: 294, h: 800 });
  assert.equal(p.axis, 'x'); assert.equal(p.world.w, 14 * 294 + 13 * 8);
});
test('Focus left/right: first pane takes 58%, the rest share the side region', () => {
  const l = place(arr('left'), A);
  assert.deepEqual(l.focus, { id: 'p0', rect: { x: 0, y: 0, w: 691, h: 800 } });
  assert.deepEqual(l.region, { x: 699, y: 0, w: 501, h: 800 }); assert.ok(!l.rects.has('p0'));
  const r = place(arr('right'), A);
  assert.deepEqual(r.focus.rect, { x: 509, y: 0, w: 691, h: 800 }); assert.deepEqual(r.region, { x: 0, y: 0, w: 501, h: 800 });
});
test('focus width clamps to [320, width − 8 − 260]; too narrow means no focus pane', () => {
  assert.equal(place(arr('left', { focusShare: 0.95 }), A).focus.rect.w, 932);
  assert.equal(place(arr('left', { focusShare: 0.1 }), A).focus.rect.w, 320);
  assert.equal(place(arr('left'), { w: 580, h: 800 }).focus, null);
});
test('a non-finite Focus divider position falls back to the default', () => {
  for (const focusShare of [NaN, Infinity, -Infinity]) {
    assert.deepEqual(place(arr('left', { focusShare }), A).focus.rect, { x: 0, y: 0, w: 691, h: 800 });
  }
});
test('one pane fills the area in every mode', () => {
  for (const mode of ['horizontal', 'vertical', 'grid', 'left', 'right']) {
    const p = place({ mode, order: ['a'], zoom: 1, focusShare: 0.58 }, A);
    assert.deepEqual(p.focus?.rect ?? p.rects.get('a'), { x: 0, y: 0, w: 1200, h: 800 });
  }
});
test('saved trees migrate: order kept; Focus left only when the tree really is one', () => {
  const L = (id) => ({ kind: 'leaf', id });
  const focusLeft = { kind: 'split', dir: 'row', sizes: [0.6, 0.4], children: [L('a'), { kind: 'split', dir: 'column', sizes: [0.5, 0.5], children: [L('b'), L('c')] }] };
  // What arrange('grid') builds for three panes. It never resets the saved `layout`, so "left" can sit beside it (App.tsx:913-914).
  const evenGrid = { kind: 'split', dir: 'column', sizes: [0.5, 0.5], children: [{ kind: 'split', dir: 'row', sizes: [0.5, 0.5], children: [L('a'), L('b')] }, L('c')] };
  assert.deepEqual(arrangementFromSaved(focusLeft, 'left', ['a', 'b', 'c']), { mode: 'left', order: ['a', 'b', 'c'], zoom: 1, focusShare: 0.58 });
  assert.equal(arrangementFromSaved(evenGrid, 'left', ['a', 'b', 'c']).mode, 'grid');
  assert.equal(arrangementFromSaved(focusLeft, 'top', ['a', 'b', 'c']).mode, 'grid');
  const twoEqual = { kind: 'split', dir: 'row', sizes: [0.5, 0.5], children: [L('a'), L('b')] };
  assert.equal(arrangementFromSaved(twoEqual, 'left', ['a', 'b']).mode, 'grid');
  assert.equal(arrangementFromSaved({ ...twoEqual, sizes: [0.6, 0.4] }, 'left', ['a', 'b']).mode, 'left');
  assert.deepEqual(arrangementFromSaved('junk', 'top', ['x', 'y']).order, ['x', 'y']);
});
test('no panes, or an area with no size: an empty placement, never a throw', () => {
  for (const [order, area] of [[[], A], [ids, { w: 0, h: 0 }]]) {
    const p = place({ mode: 'grid', order, zoom: 1, focusShare: 0.58 }, area);
    assert.equal(p.rects.size, 0); assert.equal(p.focus, null); assert.deepEqual(p.snaps, [0]); assert.equal(p.levelIdx, -1);
  }
});
test('stored arrangements are checked: unknown mode → grid, bad zoom → 1, closed panes dropped, new panes appended', () => {
  assert.deepEqual(validArrangement({ mode: 'diagonal', order: ['a', 'gone'], zoom: NaN, focusShare: 2 }, ['a', 'b']),
    { mode: 'grid', order: ['a', 'b'], zoom: 1, focusShare: 0.58 });
});

