import test from 'node:test';
import assert from 'node:assert/strict';
import * as arrangement from '../src/paneArrangement.ts';

test('opening an existing Dashboard session keeps its place and never duplicates it', () => {
  assert.equal(typeof arrangement.placeInOrder, 'function');
  const order = ['a', 'b'];
  assert.deepEqual(arrangement.placeInOrder(order, 'b'), ['a', 'b']);
  assert.deepEqual(arrangement.placeInOrder(order, 'c'), ['a', 'b', 'c']);
  assert.deepEqual(arrangement.placeInOrder([], 'c'), ['c']);
  assert.deepEqual(order, ['a', 'b']);
});

test('a selected Dashboard destination trades positions while keeping both sessions', () => {
  assert.equal(typeof arrangement.placeInOrder, 'function');
  assert.deepEqual(arrangement.placeInOrder(['a', 'b'], 'c', 'b'), ['a', 'c', 'b']);
  assert.deepEqual(arrangement.placeInOrder(['a', 'b', 'c'], 'c', 'a'), ['c', 'b', 'a']);
  assert.deepEqual(arrangement.placeInOrder(['a', 'b'], 'b', 'b'), ['a', 'b']);
  assert.throws(() => arrangement.placeInOrder(['a', 'b'], 'c', 'gone'), /no longer available/);
});
