import test from 'node:test';
import assert from 'node:assert/strict';
import { detailsOverlay } from '../src/detailsLayout.ts';
test('details dock only when at least 560px remains for panes', () => {
  assert.equal(detailsOverlay(879), true);
  assert.equal(detailsOverlay(880), false);
  assert.equal(detailsOverlay(1200), false);
  assert.equal(detailsOverlay(0), true);
});

test('a wider details sidebar overlays sooner', () => {
  assert.equal(detailsOverlay(1000, 480), true);
  assert.equal(detailsOverlay(1040, 480), false);
});
