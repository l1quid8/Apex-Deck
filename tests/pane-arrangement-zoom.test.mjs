import test from 'node:test'; import assert from 'node:assert/strict';
import { place, stepZoom, chooseAnchor, centreId, scrollFor, zoomScroll, insertIndex, reorder } from '../src/paneArrangement.ts';
const ids = Array.from({ length: 14 }, (_, i) => `p${i}`); const A = { w: 1200, h: 800 };
const a = { mode: 'grid', order: ids, zoom: 1, focusShare: 0.58 };
test('one step is exactly one level; the ends hold', () => {
  const inA = { ...a, zoom: stepZoom(a, A, 1) }; assert.equal(place(inA, A).levelIdx, 2);    // 3x3
  const outA = { ...a, zoom: stepZoom(a, A, -1) }; assert.equal(place(outA, A).levelIdx, 0); // all 14 fit
  assert.equal(stepZoom(outA, A, -1), outA.zoom);
});
test('active panes stay fully on screen, on a whole row', () => {
  const next = place({ ...a, zoom: stepZoom(a, A, 1) }, A);
  const anchor = chooseAnchor(next, ['p9'], null, null); assert.deepEqual(anchor, { kind: 'active', ids: ['p9'] });
  const y = scrollFor(next, anchor, 0); const r = next.rects.get('p9');
  assert.ok(r.y >= y && r.y + r.h <= y + next.region.h); assert.ok(next.snaps.includes(y));
});
test('when active panes can no longer all fit, the pointer wins, and a held target stays', () => {
  const next = place({ ...a, zoom: stepZoom(a, A, 1) }, A);
  assert.deepEqual(chooseAnchor(next, ['p0', 'p13'], 'p5', null), { kind: 'pane', id: 'p5' });
  assert.deepEqual(chooseAnchor(next, ['p0', 'p13'], 'p6', 'p5'), { kind: 'pane', id: 'p5' });
  assert.deepEqual(chooseAnchor(next, ['p0', 'p13'], null, null), { kind: 'pane', id: 'p0' }); // keyboard: no pointer
});
test('the focus pane is not in the region, so zoom follows the pointer', () => {
  const next = place({ ...a, mode: 'left' }, A);
  assert.deepEqual(chooseAnchor(next, ['p0'], 'p3', null), { kind: 'pane', id: 'p3' });
});
test('keyboard zoom with the Focus pane active keeps the middle of the region; an empty region has no anchor', () => {
  const left = { ...a, mode: 'left' }; const now = place(left, A);
  const dist = (r, x, y) => Math.hypot(Math.max(r.x - x, 0, x - r.x - r.w), Math.max(r.y - y, 0, y - r.y - r.h));
  const cx = now.region.w / 2, cy = now.region.h / 2;
  const c = centreId(now, 0);
  assert.equal(dist(now.rects.get(c), cx, cy), Math.min(...[...now.rects.values()].map((r) => dist(r, cx, cy))));
  const next = place({ ...left, zoom: stepZoom(left, A, 1) }, A);
  assert.deepEqual(chooseAnchor(next, ['p0'], null, null, c), { kind: 'pane', id: c });   // p0 is the Focus pane, not in next.rects
  assert.equal(chooseAnchor(place({ ...a, order: [] }, A), [], null, null, null), null);
  assert.ok(next.snaps.includes(scrollFor(next, null, 37)));
});
test('drag: dropping over the third cell moves the pane there', () => {
  const p = place(a, A); const r = p.rects.get('p2');
  assert.equal(insertIndex(p, { x: r.x + r.w / 2, y: r.y + r.h / 2 }, 'p0'), 2);
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 'a', 2), ['b', 'c', 'a', 'd']);
});

test('drag hit-testing follows scrolled panes while the Focus pane stays pinned', () => {
  for (const mode of ['grid', 'horizontal', 'vertical', 'left', 'right']) {
    const p = place({ ...a, mode }, A);
    const r = p.rects.get('p13');
    const scroll = scrollFor(p, { kind: 'active', ids: ['p13'] }, 0);
    const point = {
      x: p.region.x + r.x + r.w / 2 - (p.axis === 'x' ? scroll : 0),
      y: p.region.y + r.y + r.h / 2 - (p.axis === 'y' ? scroll : 0),
    };
    assert.equal(insertIndex(p, point, 'p0', scroll), 13, mode);
    if (p.focus) {
      const f = p.focus.rect;
      assert.equal(insertIndex(p, { x: f.x + f.w / 2, y: f.y + f.h / 2 }, 'p13', scroll), 0, mode);
    }
  }
});

const z33 = { ...a, zoom: stepZoom(a, A, 1) };
const p33 = place(z33, A);
const p32 = place({ ...a, zoom: stepZoom(z33, A, 1) }, A);
const near = (a, b) => Math.abs(a - b) < 0.01;
test('zooming in keeps a top-line pane on the top line', () => {
  const r = p33.rects.get('p6');
  const at = r.y - p33.snaps.at(-1) + r.h / 2;
  assert.ok(near(zoomScroll(p32, chooseAnchor(p32, ['p6'], null, null), at), 808));
});
test('zooming out keeps a bottom-line pane on the bottom line', () => {
  const r = p32.rects.get('p8');
  const at = r.y - p32.snaps[1] + r.h / 2;
  assert.equal(zoomScroll(p33, chooseAnchor(p33, ['p8'], null, null), at), 0);
});
test('zoom keeps the whole selected group visible even if its middle would move the top line', () => {
  const anchor = chooseAnchor(p32, ['p6', 'p9'], null, null);
  assert.deepEqual(anchor, { kind: 'active', ids: ['p6', 'p9'] });
  assert.ok(near(zoomScroll(p32, anchor, 700), 808)); // the point alone gives 404, which cuts p9 off
  assert.ok(near(zoomScroll(p32, chooseAnchor(p32, ['p13'], null, null), 0), 1212)); // the point alone gives 1616, past the last line
});
test('zoom without a screen point centres the anchor line; no anchor starts at zero', () => {
  const p = place({ ...a, mode: 'horizontal' }, A);
  assert.ok(near(zoomScroll(p, { kind: 'pane', id: 'p7' }, null), 1616));
  assert.equal(zoomScroll(place({ ...a, order: [] }, A), null, null), 0);
});
test('keyboard zoom chooses the middle selected pane in pane order, not selection order', () => {
  assert.deepEqual(chooseAnchor(p32, ['p13', 'p0', 'p7'], null, null), { kind: 'pane', id: 'p7' });
});
test('vertical zoom uses horizontal screen position and clamps points outside the region', () => {
  const p = place({ ...a, mode: 'vertical' }, A); // four columns, stride 302
  for (const [at, want] of [[null, 1812], [0, 2114], [-200, 2114], [1200, 1208], [1500, 1208]]) {
    assert.equal(zoomScroll(p, { kind: 'pane', id: 'p7' }, at), want, `at=${at}`);
  }
  const next = place({ ...a, mode: 'vertical', zoom: stepZoom({ ...a, mode: 'vertical' }, A, 1) }, A);
  assert.ok(near(zoomScroll(next, { kind: 'pane', id: 'p6' }, 147), 2416));
});
test('group zoom uses the middle pane in map order regardless of tag order', () => {
  const p = place({ ...a, mode: 'horizontal', zoom: 3 / 7 }, A); // seven rows, several legal snaps
  assert.ok(near(zoomScroll(p, { kind: 'active', ids: ['p7', 'p5', 'p6'] }, null), 346.285714));
  assert.deepEqual(chooseAnchor(p, ['p7', 'p5', 'p6'], null, null), { kind: 'active', ids: ['p5', 'p6', 'p7'] });
});

