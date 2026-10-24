import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { newestFirst, readArtifacts } from '../src/artifacts.ts';

// assistantOutputs.ts imports './artifacts' without an extension, which the node
// runner cannot resolve; it is stripped and the real artifact helpers are bound
// in instead. The logic under test is the file's own.
const require = createRequire(import.meta.url);
const { transform } = require('sucrase');
const source = fs.readFileSync(new URL('../src/assistantOutputs.ts', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const code = transform(source.replace(/^export /gm, ''), { transforms: ['typescript'], jsxRuntime: 'classic' }).code;
const api = new Function(
  'newestFirst',
  'readArtifacts',
  `${code}\nreturn {kindOfOutputPath,outputName,outputsFromArtifacts,outputsFromChanges,mergeOutputs,outputsLine,previewSource,loadOutputs,OUTPUT_MARK,MAX_PREVIEW,MAX_OUTPUT_THREADS};`,
)(newestFirst, readArtifacts);

const art = (id, kind, at, path, source = 'body') => ({
  id,
  title: `Title ${id}`,
  kind,
  versions: [{ n: 1, source, by: null, seq: 1, at }],
  ...(path ? { path } : {}),
});
const file = (path) => ({ path, added: 1, removed: 0, patch: '', by: [] });

test('a path is an output only when its extension is a deliverable', () => {
  assert.equal(api.kindOfOutputPath('notes/report.md'), 'doc');
  assert.equal(api.kindOfOutputPath('release.PDF'), 'doc');
  assert.equal(api.kindOfOutputPath('data/export.json'), 'data');
  assert.equal(api.kindOfOutputPath('dashboard.html'), 'view');
  assert.equal(api.kindOfOutputPath('src/App.tsx'), null, 'code changes belong in Review');
  assert.equal(api.kindOfOutputPath('scripts/build.mjs'), null);
  assert.equal(api.kindOfOutputPath('Makefile'), null);
});

test('a path splits into its name and the folder above it', () => {
  assert.deepEqual(api.outputName('notes/report.md'), { name: 'report.md', folder: 'notes' });
  assert.deepEqual(api.outputName('report.md'), { name: 'report.md', folder: '' });
});

test('artifacts become outputs newest first, with their versions and folder', () => {
  const list = api.outputsFromArtifacts({ version: 1, artifacts: [
    art('a', 'markdown', 100, 'notes/brief.md'),
    art('b', 'html', 300, undefined),
    art('c', 'svg', 200, 'assets/logo.svg'),
  ] }, 'thread-1', '/work/project', 'task-1');
  assert.deepEqual(list.map((o) => o.name), ['Title b', 'logo.svg', 'brief.md']);
  assert.deepEqual(list.map((o) => o.kind), ['view', 'view', 'doc']);
  assert.equal(list[1].folder, 'assets');
  assert.equal(list[2].threadId, 'thread-1');
  assert.equal(list[2].taskId, 'task-1');
  assert.equal(list[2].cwd, '/work/project');
  assert.equal(list[0].artifact.id, 'b');
  assert.equal(list[0].path, undefined, 'a page that only lived in a reply has no path');
});

test('files a thread changed count only when they are deliverables', () => {
  const list = api.outputsFromChanges(
    [file('notes/brief.md'), file('src/App.tsx'), file('out/data.json'), file('out/big.pdf'), file('package.json')],
    'thread-2', '/work/project', 'task-2',
  );
  assert.deepEqual(list.map((o) => o.name), ['brief.md', 'data.json', 'big.pdf', 'package.json']);
  assert.deepEqual(list.map((o) => o.kind), ['doc', 'data', 'doc', 'data']);
  assert.equal(list[1].cwd, '/work/project');
});

test('one row per path, and an artifact beats a bare file row', () => {
  const artifactRow = api.outputsFromArtifacts({ version: 1, artifacts: [art('a', 'markdown', 500, 'notes/brief.md')] }, 'thread-1')[0];
  const bareRow = api.outputsFromChanges([file('notes/brief.md')], 'thread-1')[0];
  const jsonRow = api.outputsFromChanges([file('out/data.json')], 'thread-1')[0];
  const merged = api.mergeOutputs([bareRow], [artifactRow, jsonRow], [jsonRow]);
  assert.equal(merged.length, 2, 'the same file appears once');
  const brief = merged.find((o) => o.name === 'brief.md');
  assert.ok(brief.artifact, 'the artifact carries the versions');
  assert.equal(merged[0].name, 'brief.md', 'and it is newest first');
});

test('the line counts deliverables', () => {
  assert.equal(api.outputsLine([]), 'No deliverables yet');
  assert.equal(api.outputsLine([{ kind: 'doc' }]), '1 deliverable');
  assert.equal(api.outputsLine([{ kind: 'doc' }, { kind: 'data' }]), '2 deliverables');
});

test('a preview is cut to what a sidebar can render', () => {
  const long = art('a', 'markdown', 1, 'x.md', 'x'.repeat(api.MAX_PREVIEW + 5));
  const shown = api.previewSource(long);
  assert.equal(shown.length, api.MAX_PREVIEW + 2);
  assert.ok(shown.endsWith('…'));
  assert.equal(api.previewSource(art('b', 'markdown', 1, 'y.md', 'short')), 'short');
});

test('loadOutputs reads each thread once and passes its folder along', async () => {
  const calls = [];
  const backend = {
    artifactsLoad: async (room) => { calls.push(`artifacts:${room}`); return { version: 1, artifacts: [art('a', 'markdown', 10, 'notes/brief.md')] }; },
    roomDiff: async (room) => { calls.push(`diff:${room}`); return { files: [file('out/data.json'), file('src/App.tsx')] }; },
  };
  const tasks = [
    { id: 't1', owner: { cwd: '/work/a' }, destination: { threadId: 'thread-1' } },
    { id: 't2', owner: { cwd: '/work/a' }, destination: { threadId: 'thread-1' } },
    { id: 't3', owner: { cwd: '/work/a' }, destination: { threadId: null } },
  ];
  const list = await api.loadOutputs(backend, tasks);
  assert.deepEqual(calls, ['artifacts:thread-1', 'diff:thread-1'], 'one thread, asked once');
  assert.deepEqual(list.map((o) => o.name), ['brief.md', 'data.json']);
  assert.equal(list[0].cwd, '/work/a');
  assert.equal(list[0].taskId, 't1');
});

test('a thread that cannot be read contributes nothing instead of failing the list', async () => {
  const backend = {
    artifactsLoad: async () => { throw new Error('unreadable'); },
    roomDiff: async () => { throw new Error('not a repository'); },
  };
  const tasks = [{ id: 't1', owner: { cwd: '/work/a' }, destination: { threadId: 'thread-1' } }];
  assert.deepEqual(await api.loadOutputs(backend, tasks), []);
});

test('a damaged artifacts file degrades to no artifacts', async () => {
  const backend = {
    artifactsLoad: async () => ({ nope: true }),
    roomDiff: async () => ({ files: [file('out/data.json')] }),
  };
  const list = await api.loadOutputs(backend, [{ id: 't1', destination: { threadId: 'thread-9' } }]);
  assert.deepEqual(list.map((o) => o.name), ['data.json']);
});

test('only the most recent threads are asked', async () => {
  let asked = 0;
  const backend = {
    artifactsLoad: async () => { asked += 1; return null; },
    roomDiff: async () => ({ files: [] }),
  };
  const tasks = Array.from({ length: api.MAX_OUTPUT_THREADS + 4 }, (_, i) => ({ id: `t${i}`, destination: { threadId: `thread-${i}` } }));
  await api.loadOutputs(backend, tasks);
  assert.equal(asked, api.MAX_OUTPUT_THREADS);
});
