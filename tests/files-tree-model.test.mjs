import test from 'node:test';
import assert from 'node:assert/strict';
import { createTree, visibleRows, toggle, collapseAll, revealPath, moveSelection, changeMarks, parseFilesPrefs } from '../src/filesTreeModel.ts';

const listing = (path, folders = [], files = []) => ({ path, parent: null, folders, files, truncated: false });

test('visibleRows flattens folders with depth and hides dotfiles by default', () => {
  const tree = createTree('/sample');
  tree.entries.set('/sample', { state: 'ready', listing: listing('/sample', ['src', '.hidden'], ['README.md']) });
  tree.expanded.add('/sample/src');
  tree.entries.set('/sample/src', { state: 'ready', listing: listing('/sample/src', [], ['main.ts']) });
  assert.deepEqual(visibleRows(tree, { changes: new Map(), changedOnly: false, showHidden: false }).map(({ name, depth }) => [name, depth]), [['src', 0], ['main.ts', 1], ['README.md', 0]]);
});

test('changed-only includes changed ancestors, hidden changed files and deleted entries', () => {
  const tree = createTree('/sample');
  tree.entries.set('/sample', { state: 'ready', listing: listing('/sample', ['src'], ['.secret']) });
  tree.entries.set('/sample/src', { state: 'ready', listing: listing('/sample/src', [], ['edit.ts']) });
  const changes = new Map([['/sample/src/edit.ts', 'M'], ['/sample/.secret', 'A'], ['/sample/gone.md', 'D']]);
  assert.deepEqual(visibleRows(tree, { changes, changedOnly: true, showHidden: false }).map((row) => [row.path, row.changed]), [['/sample/src', null], ['/sample/src/edit.ts', 'M'], ['/sample/.secret', 'A'], ['/sample/gone.md', 'D']]);
});

test('toggle, collapseAll and revealPath update expansion and pending listings', () => {
  let tree = createTree('/sample');
  tree = toggle(tree, '/sample/docs');
  assert.equal(tree.entries.get('/sample/docs').state, 'loading');
  tree = collapseAll(tree);
  assert.equal(tree.expanded.size, 0);
  const revealed = revealPath(tree, '/sample/docs/readme.md');
  assert.deepEqual(revealed.needs, ['/sample/docs']);
  assert.equal(revealed.tree.selected, '/sample/docs/readme.md');
});

test('keyboard selection moves and expands or moves to a parent', () => {
  const rows = [{ path: '/r/f', name: 'f', depth: 0, folder: true, changed: null, hasChangedInside: false }, { path: '/r/f/a', name: 'a', depth: 1, folder: false, changed: null, hasChangedInside: false }];
  assert.deepEqual(moveSelection(rows, '/r/f', 'ArrowDown'), { selected: '/r/f/a' });
  assert.deepEqual(moveSelection(rows, '/r/f', 'ArrowRight'), { selected: '/r/f', action: 'expand' });
  assert.equal(moveSelection(rows, '/r/f/a', 'ArrowLeft').selected, '/r/f');
  assert.equal(moveSelection(rows, '/r/f', 'End').selected, '/r/f/a');
});

test('changeMarks recognizes added, modified, and deleted diff patches', () => {
  const marks = changeMarks({ files: [
    { path: 'new', patch: '--- /dev/null\n+++ b/new', added: 1, removed: 0, by: [] },
    { path: 'gone', patch: '--- a/gone\n+++ /dev/null', added: 0, removed: 1, by: [] },
    { path: 'edit', patch: '--- a/edit\n+++ b/edit', added: 1, removed: 1, by: [] },
  ], note: null }, '/sample');
  assert.deepEqual([...marks], [['/sample/new', 'A'], ['/sample/gone', 'D'], ['/sample/edit', 'M']]);
});

test('storage parser repairs malformed preferences and keeps at most twenty roots', () => {
  assert.deepEqual(parseFilesPrefs('{'), {});
  const parsed = parseFilesPrefs(JSON.stringify(Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`/${i}`, { expanded: [1, '/x'], changedOnly: 1, showHidden: true }]))));
  assert.equal(Object.keys(parsed).length, 20);
  assert.deepEqual(parsed['/21'], { expanded: ['/x'], changedOnly: false, showHidden: true, previewHeight: 280, treeWidth: 280 });
  assert.equal(parseFilesPrefs('{"/a":{"treeWidth":9999}}')['/a'].treeWidth, 600);
  assert.equal(parseFilesPrefs('{"/a":{"treeWidth":5}}')['/a'].treeWidth, 180);
});
