import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantOutputs, outputKindLabel, outputMark, outputName, outputsLine, parsePatchFiles} from '../src/assistantOutputs.ts';

// Shaped like what the host writes into resultData.reviewDiff.
const twoFiles = [
  'diff --git a/src/App.tsx b/src/App.tsx',
  'index 1111111..2222222 100644',
  '--- a/src/App.tsx',
  '+++ b/src/App.tsx',
  '@@ -1,2 +1,3 @@',
  '-const title = "Deck";',
  '+const title = "Apex Deck";',
  '+export default null;',
  ' export {};',
  'diff --git a/docs/notes.md b/docs/notes.md',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/docs/notes.md',
  '@@ -0,0 +1,2 @@',
  '+# Notes',
  '+Two lines.',
].join('\n') + '\n';

test('a recorded patch splits into one row per file with its line counts', () => {
  const files = parsePatchFiles(twoFiles);
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((f) => [f.path, f.added, f.removed, f.kind]), [
    ['src/App.tsx', 2, 1, 'changed'],
    ['docs/notes.md', 2, 0, 'created'],
  ]);
  assert.match(files[0].patch, /^diff --git a\/src\/App\.tsx/);
  assert.match(files[1].patch, /\+Two lines\./);
});

test('a deleted file keeps the path it had and is marked deleted', () => {
  const patch = [
    'diff --git a/old/plan.md b/old/plan.md',
    'deleted file mode 100644',
    '--- a/old/plan.md',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-# Plan',
  ].join('\n');
  assert.deepEqual(parsePatchFiles(patch).map((f) => [f.path, f.removed, f.kind]), [['old/plan.md', 1, 'deleted']]);
});

test('a binary file is listed with no line counts', () => {
  const patch = ['diff --git a/art/logo.png b/art/logo.png', 'new file mode 100644', 'Binary files /dev/null and b/art/logo.png differ'].join('\n');
  assert.deepEqual(parsePatchFiles(patch).map((f) => [f.path, f.added, f.removed, f.kind]), [['art/logo.png', 0, 0, 'created']]);
});

test('--- and +++ header lines are not counted as removed and added lines', () => {
  const [file] = parsePatchFiles(twoFiles);
  assert.equal(file.added, 2);
  assert.equal(file.removed, 1);
});

test('outputs merge the same path across tasks and keep every task that touched it', () => {
  const first = ['diff --git a/src/one.ts b/src/one.ts', '--- a/src/one.ts', '+++ b/src/one.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n');
  const second = ['diff --git a/src/one.ts b/src/one.ts', '--- a/src/one.ts', '+++ b/src/one.ts', '@@ -1,2 +1,3 @@', '-a', '+b', '+c', '+d'].join('\n');
  const created = ['diff --git a/src/two.ts b/src/two.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/two.ts', '@@ -0,0 +1 @@', '+x'].join('\n');
  const rows = assistantOutputs([
    {id: 'task-1', resultData: {reviewDiff: first}},
    {id: 'task-2', resultData: {reviewDiff: `${second}\n${created}`}},
  ]);
  assert.deepEqual(rows.map((r) => [r.path, r.added, r.removed, r.kind, r.taskIds]), [
    ['src/one.ts', 4, 2, 'changed', ['task-1', 'task-2']],
    ['src/two.ts', 1, 0, 'created', ['task-2']],
  ]);
  // The longer patch is the one kept for the file.
  assert.match(rows[0].patch, /\+d/);
});

test('a merged file stays created when a later task edits it', () => {
  const made = ['diff --git a/a.md b/a.md', 'new file mode 100644', '--- /dev/null', '+++ b/a.md', '@@ -0,0 +1 @@', '+one'].join('\n');
  const edited = ['diff --git a/a.md b/a.md', '--- a/a.md', '+++ b/a.md', '@@ -1 +1,2 @@', '+one', '+two'].join('\n');
  const rows = assistantOutputs([{id: 'a', resultData: {reviewDiff: made}}, {id: 'b', resultData: {reviewDiff: edited}}]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'created');
  assert.deepEqual(rows[0].taskIds, ['a', 'b']);
});

test('tasks with no patch, a blank patch or no result at all add nothing', () => {
  assert.deepEqual(assistantOutputs([
    {id: 'read-only', resultData: {}},
    {id: 'blank', resultData: {reviewDiff: '   \n'}},
    {id: 'empty', resultData: {reviewDiff: ''}},
    {id: 'none'},
    {id: 'null', resultData: null},
  ]), []);
  assert.deepEqual(assistantOutputs([]), []);
});

test('a patch with no diff header yields no rows rather than a nameless one', () => {
  assert.deepEqual(parsePatchFiles('just some text\n+junk\n'), []);
});

test('rows read as name, folder, mark and a line of totals', () => {
  assert.deepEqual(outputName('src/panel/RightPanel.tsx'), {name: 'RightPanel.tsx', folder: 'src/panel'});
  assert.deepEqual(outputName('README.md'), {name: 'README.md', folder: ''});
  assert.equal(outputMark('created'), 'A');
  assert.equal(outputMark('deleted'), 'D');
  assert.equal(outputMark('changed'), 'M');
  assert.equal(outputKindLabel('created'), 'Created');
  assert.equal(outputsLine([{added: 24, removed: 6}, {added: 24, removed: 0}]), '2 files · +48 −6');
  assert.equal(outputsLine([{added: 1, removed: 0}]), '1 file · +1 −0');
  assert.equal(outputsLine([]), '0 files · +0 −0');
});
