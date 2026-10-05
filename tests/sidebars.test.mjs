import test from 'node:test';
import assert from 'node:assert/strict';
import { SIDEBAR_LIMITS, clampWidth, dragWidth, parseWidths } from '../src/sidebars.ts';

test('widths stay inside each sidebar\'s limits', () => {
  assert.equal(clampWidth('rail', 10), SIDEBAR_LIMITS.rail.min);
  assert.equal(clampWidth('rail', 9999), SIDEBAR_LIMITS.rail.max);
  assert.equal(clampWidth('details', 300.6), 301);
});

test('the rail widens moving right, the details widen moving left', () => {
  assert.equal(dragWidth('rail', 240, 40), 280);
  assert.equal(dragWidth('details', 320, -40), 360);
  assert.equal(dragWidth('details', 320, 40), 280);
  assert.equal(dragWidth('rail', 240, -500), SIDEBAR_LIMITS.rail.min);
});

test('saved widths are read back, defaults kept for anything missing or bad', () => {
  assert.deepEqual(parseWidths(null), { rail: null, details: null });
  assert.deepEqual(parseWidths('not json'), { rail: null, details: null });
  assert.deepEqual(parseWidths('{"rail":300,"details":"wide"}'), { rail: 300, details: null });
  assert.deepEqual(parseWidths('{"rail":5,"details":5000}'), { rail: SIDEBAR_LIMITS.rail.min, details: SIDEBAR_LIMITS.details.max });
});
