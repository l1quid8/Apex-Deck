import test from 'node:test';
import assert from 'node:assert/strict';
import { leafIds, rects } from '../src/layout.ts';
import { placeDashboardPane } from '../src/dashboardNavigation.ts';

const leaf = id => ({ kind: 'leaf', id });
const tree = { kind: 'split', dir: 'row', children: [leaf('a'), leaf('b')], sizes: [0.7, 0.3] };

test('opening an existing Dashboard session never duplicates it', () => {
  assert.equal(placeDashboardPane(tree, 'a'), tree);
  assert.deepEqual(leafIds(placeDashboardPane(tree, 'c')).sort(), ['a', 'b', 'c']);
  assert.deepEqual(placeDashboardPane(null, 'c'), leaf('c'));
});

test('opening in a selected pane uses its rectangle while keeping both sessions', () => {
  const swapped = placeDashboardPane(tree, 'a', 'b');
  assert.deepEqual(rects(swapped).get('a'), rects(tree).get('b'));
  assert.deepEqual(rects(swapped).get('b'), rects(tree).get('a'));
  const reopened = placeDashboardPane(tree, 'c', 'b');
  assert.deepEqual(rects(reopened).get('c'), rects(tree).get('b'));
  assert.deepEqual(leafIds(reopened).sort(), ['a', 'b', 'c']);
  assert.throws(() => placeDashboardPane(tree, 'c', 'gone'), /no longer available/);
  assert.deepEqual(tree.sizes, [0.7, 0.3]);
});
