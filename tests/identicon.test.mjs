import test from 'node:test';
import assert from 'node:assert/strict';
import { identiconCells } from '../src/identicon.ts';

const ids = ['null', 'jigga', 'opus', 'reviewer', 'a', 'gpt-5', 'claude.code', 'x_1'];

test('a pattern is 25 cells and the same id always draws the same pattern', () => {
  for (const id of ids) {
    const cells = identiconCells(id);
    assert.equal(cells.length, 25);
    assert.deepEqual(identiconCells(id), cells);
  }
});

test('patterns are mirrored left to right, so each half carries the whole identity', () => {
  for (const id of ids) {
    const cells = identiconCells(id);
    for (let row = 0; row < 5; row++) {
      assert.equal(cells[row * 5 + 0].on, cells[row * 5 + 4].on, `${id} row ${row} outer`);
      assert.equal(cells[row * 5 + 1].on, cells[row * 5 + 3].on, `${id} row ${row} inner`);
    }
  }
});

test('no pattern is nearly empty or nearly solid', () => {
  for (let i = 0; i < 500; i++) {
    const lit = identiconCells(`agent-${i}`).filter((c) => c.on).length;
    assert.ok(lit >= 7 && lit <= 18, `agent-${i} lights ${lit} cells`);
  }
});

test('different ids usually draw different patterns', () => {
  const seen = new Set(ids.map((id) => identiconCells(id).map((c) => (c.on ? 1 : 0)).join('')));
  assert.equal(seen.size, ids.length);
});

test('the working shimmer runs as a diagonal wave from the top left', () => {
  const cells = identiconCells('jigga');
  assert.equal(cells[0].wave, 0);
  assert.equal(cells[4].wave, 4);
  assert.equal(cells[24].wave, 8);
});
