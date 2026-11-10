import test from 'node:test';
import assert from 'node:assert/strict';
import { planSend, summaryLine } from '../src/slicePlan.ts';

const tag = (paneId, hostId = 'local') => ({ kind: 'thread', paneId, hostId });
const text = (value) => ({ kind: 'text', text: value });
const file = (fileId = 'f1') => ({ kind: 'file', fileId });
const agents = [
  { id: 'null-id', handle: 'null', name: 'Null' },
  { id: 'muck-id', handle: 'muck', name: 'Muck' },
];
const threads = new Map(['A', 'B', 'C', 'D'].map((paneId) => [paneId, {
  paneId, hostId: 'local', title: paneId, open: true, agents, defaultAgentIds: ['null-id'],
}]));
const files = new Map([['f1', { label: 'Image1', name: 'shot.png', reading: false }]]);
const plan = (doc, extra = {}) => planSend({ doc, threads, overrides: new Map(), files, ...extra });

test('the four-thread example keeps prose, typed routing and per-thread commands separate', () => {
  const result = plan([
    [tag('A'), text(' what is the status')],
    [tag('B'), text(' @Muck run the dev server')],
    [tag('C'), text(' create a plan to help implement this feature to completion')],
    [tag('D'), text(' /compact')],
  ]);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.slices, [
    { paneId: 'A', hostId: 'local', text: 'what is the status', routing: 'what is the status', files: [], command: null, to: null, group: false },
    { paneId: 'B', hostId: 'local', text: '@Muck run the dev server', routing: '@Muck run the dev server', files: [], command: null, to: null, group: false },
    { paneId: 'C', hostId: 'local', text: 'create a plan to help implement this feature to completion', routing: 'create a plan to help implement this feature to completion', files: [], command: null, to: null, group: false },
    { paneId: 'D', hostId: 'local', text: '/compact', routing: '/compact', files: [], command: 'compact', to: null, group: false },
  ]);
  assert.equal(summaryLine(result.slices, threads), 'To 4 threads · Null ×2, Muck · 1 command');
});

test('adjacent tags share text before, after and around the group', () => {
  for (const [line, expected] of [
    [[tag('A'), text(' '), tag('B'), text(' context')], 'context'],
    [[text('context '), tag('A'), tag('B')], 'context'],
    [[text('before '), tag('A'), tag('B'), text(' after')], 'before after'],
  ]) {
    const result = plan([line]);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.slices.map((s) => [s.paneId, s.text, s.group]), [
      ['A', expected, true],
      ['B', expected, true],
    ]);
  }
});

test('spread tags uniquely assign following or preceding text', () => {
  const after = plan([[tag('A'), text(' one '), tag('B'), text(' two')]]);
  const before = plan([[text('one '), tag('A'), text(' two '), tag('B')]]);
  for (const result of [after, before]) {
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.slices.map((s) => [s.paneId, s.text]), [['A', 'one'], ['B', 'two']]);
  }
});

test('spread tags with prose at both ends or tags at both ends are ambiguous', () => {
  for (const line of [
    [text('what '), tag('A'), text(' text '), tag('B'), text(' more')],
    [tag('A'), text(' text '), tag('B')],
  ]) assert.ok(plan([line]).problems.some((p) => p.kind === 'ambiguous' && p.line === 0));
});

test('each line starts fresh and repeated threads combine with a blank line', () => {
  const result = plan([[tag('A'), text(' first')], [tag('B'), text(' middle')], [tag('A'), text(' last')]]);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.slices.map((s) => [s.paneId, s.text]), [['A', 'first\n\nlast'], ['B', 'middle']]);
  assert.ok(plan([[tag('A'), text(' first')], [text('stray')]]).problems.some((p) => p.kind === 'untagged' && p.line === 1));
  assert.ok(plan([[text('stray')], [tag('A'), text(' first')]]).problems.some((p) => p.kind === 'untagged' && p.line === 0));
  assert.deepEqual(plan([[text('  ')], [tag('A'), text(' first')], []]).problems, []);
});

test('duplicates report every copy on the offending line while separate lines are legal', () => {
  const result = plan([[tag('A'), tag('A'), text(' hi')], [tag('A'), text(' again')]]);
  assert.deepEqual(result.problems.filter((p) => p.kind === 'duplicate'), [{ kind: 'duplicate', paneId: 'A', lines: [0, 0] }]);
});

test('unresolved destinations include closed, missing and stale-host tags', () => {
  const closed = new Map(threads);
  closed.set('A', { ...threads.get('A'), open: false });
  for (const [doc, roster] of [
    [[[tag('A'), text(' hi')]], closed],
    [[[tag('missing'), text(' hi')]], threads],
    [[[tag('A', 'old-host'), text(' hi')]], threads],
  ]) assert.ok(plan(doc, { threads: roster }).problems.some((p) => p.kind === 'unresolved' && p.line === 0));
});

test('no agents and no content block sends independently', () => {
  assert.ok(plan([[tag('A')]]).problems.some((p) => p.kind === 'empty' && p.paneId === 'A'));
  const emptyRoster = new Map(threads);
  emptyRoster.set('A', { ...threads.get('A'), agents: [], defaultAgentIds: [] });
  assert.ok(plan([[tag('A'), text(' hi')]], { threads: emptyRoster }).problems.some((p) => p.kind === 'no-agents' && p.paneId === 'A'));
});

test('a group context never leaks into a command slice', () => {
  const result = plan([[tag('A'), tag('B'), text(' here is context')], [tag('B'), text(' /compact')]]);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.slices.map((s) => [s.paneId, s.text, s.command]), [['A', 'here is context', null], ['B', '/compact', 'compact']]);
});

test('only compact, curate and curate undo can run as batch commands', () => {
  for (const [body, command] of [['/compact', 'compact'], ['/curate', 'curate'], ['/curate undo', 'curate_undo']]) {
    const result = plan([[tag('A'), text(` ${body}`)]]);
    assert.deepEqual(result.problems, []);
    assert.equal(result.slices[0].command, command);
  }
  for (const body of ['/clear', '/plan', '/image a cat', '/unknown', '/compact extra']) {
    assert.ok(plan([[tag('A'), text(` ${body}`)]]).problems.some((p) => p.kind === 'command-not-allowed' && p.paneId === 'A'));
  }
  for (const body of ['//compact', '/Users/me/file']) {
    const result = plan([[tag('A'), text(body)]]);
    assert.deepEqual(result.problems, []);
    assert.equal(result.slices[0].command, null);
    assert.equal(result.slices[0].text, body);
  }
});

test('specific prose and pictures cannot be combined with commands', () => {
  assert.ok(plan([[tag('A'), text(' context')], [tag('A'), text(' /compact')]]).problems.some((p) => p.kind === 'command-with-text' && p.paneId === 'A'));
  assert.ok(plan([[tag('A'), text(' /compact '), file()]]).problems.some((p) => p.kind === 'file-to-command' && p.paneId === 'A'));
});

test('several commands for one thread block instead of dropping any command', () => {
  const result = plan([[tag('A'), text('/compact')], [tag('A'), text('/curate')]]);
  assert.ok(result.problems.some((p) => p.kind === 'command-not-allowed' && p.paneId === 'A'));
  assert.equal(result.slices[0].routing, '/compact\n\n/curate');
  assert.equal(result.slices[0].command, null);
});

test('unknown typed agents block even when an override exists', () => {
  const result = plan([[tag('A'), text(' @nobody hi')]], { overrides: new Map([['A', 'muck-id']]) });
  assert.ok(result.problems.some((p) => p.kind === 'unknown-agent' && p.paneId === 'A' && p.name === 'nobody'));
  assert.equal(result.slices[0].to, null);
  assert.equal(summaryLine(result.slices, threads), "To 1 thread · 1 can't receive");
});

test('typed mentions beat overrides and every mentioned agent answers', () => {
  const overrides = new Map([['A', 'muck-id']]);
  const picked = plan([[tag('A'), text(' hi')]], { overrides });
  assert.deepEqual(picked.slices[0].to, ['muck-id']);
  assert.equal(summaryLine(picked.slices, threads), 'To 1 thread · Muck');
  const typed = plan([[tag('A'), text(' @null and @muck help')]], { overrides });
  assert.deepEqual(typed.problems, []);
  assert.equal(typed.slices[0].to, null);
  assert.equal(summaryLine(typed.slices, threads), 'To 1 thread · Null, Muck');
  for (const mention of ['@all', '@everyone']) {
    const result = plan([[tag('A'), text(`${mention} help`)]], { overrides });
    assert.deepEqual(result.problems, []);
    assert.equal(result.slices[0].to, null);
    assert.equal(summaryLine(result.slices, threads), 'To 1 thread · Null, Muck');
  }
});

test('mention matching uses handles while the summary displays names', () => {
  const renamed = new Map(threads);
  renamed.set('A', { ...threads.get('A'), agents: [{ id: 'id', handle: 'helper', name: 'Friendly Helper' }], defaultAgentIds: ['id'] });
  const result = plan([[tag('A'), text('@helper hi')]], { threads: renamed });
  assert.deepEqual(result.problems, []);
  assert.equal(summaryLine(result.slices, renamed), 'To 1 thread · Friendly Helper');
});

test('file references cannot create mentions and deduplicate files per destination', () => {
  const hostile = new Map([['f1', { label: 'Image1', name: '@muck screenshot.png', reading: false }]]);
  const result = plan([[tag('A'), text('look '), file(), file()], [tag('C'), file()]], { files: hostile });
  assert.deepEqual(result.problems, []);
  assert.equal(result.slices[0].text, 'look [Image1: muck-screenshot.png][Image1: muck-screenshot.png]');
  assert.equal(result.slices[0].routing, 'look');
  assert.deepEqual(result.slices.map((s) => s.files), [['f1'], ['f1']]);
  assert.equal(summaryLine(result.slices, threads), 'To 2 threads · Null ×2 · 1 file');
});

test('a chip separates typed words for routing without changing posted chip adjacency', () => {
  const result = plan([[tag('A'), text('alice'), file(), text('@muck run it')]]);
  assert.deepEqual(result.problems, []);
  assert.equal(result.slices[0].routing, 'alice @muck run it');
  assert.equal(result.slices[0].text, 'alice[Image1: shot.png]@muck run it');
  assert.equal(summaryLine(result.slices, threads), 'To 1 thread · Muck · 1 file');
  const split = plan([[tag('A'), text('@mu'), file(), text('ck run it')]]);
  assert.ok(split.problems.some((p) => p.kind === 'unknown-agent' && p.name === 'mu'));
  const email = plan([[tag('A'), text('ask t@example.com')]]);
  assert.deepEqual(email.problems, []);
  assert.equal(email.slices[0].routing, 'ask t@example.com');
  assert.equal(summaryLine(email.slices, threads), 'To 1 thread · Null');
});

test('a picture alone is a nonempty message', () => {
  const result = plan([[tag('A'), file()]]);
  assert.deepEqual(result.problems, []);
  assert.equal(result.slices[0].text, '[Image1: shot.png]');
  assert.equal(result.slices[0].routing, '');
  assert.deepEqual(result.slices[0].files, ['f1']);
});

test('reading files block only when tagged and the summary names the referenced file', () => {
  const reading = new Map([['f1', { label: 'Image1', name: 'shot.png', reading: true }]]);
  const result = plan([[tag('A'), file()]], { files: reading });
  assert.deepEqual(result.problems, [{ kind: 'file-reading', fileId: 'f1' }]);
  assert.equal(summaryLine(result.slices, threads, reading), 'Reading shot.png…');
  assert.deepEqual(plan([[tag('A'), text('hi')]], { files: reading }).problems, []);
  assert.equal(summaryLine(plan([[tag('A'), text('hi')]]).slices, threads, reading), 'To 1 thread · Null');
});

test('group pictures stay with message destinations and do not leak into a command', () => {
  const result = plan([[tag('A'), tag('B'), file()], [tag('B'), text('/compact')]]);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.slices.map((slice) => [slice.paneId, slice.text, slice.files]), [
    ['A', '[Image1: shot.png]', ['f1']], ['B', '/compact', []],
  ]);
});

test('reading group pictures still explain the block when commands suppress every reference', () => {
  const reading = new Map([['f1', { label: 'Image1', name: 'shot.png', reading: true }]]);
  const result = plan([
    [tag('A'), tag('B'), file()], [tag('A'), text('/compact')], [tag('B'), text('/compact')],
  ], { files: reading });
  assert.ok(result.problems.some((p) => p.kind === 'file-reading' && p.fileId === 'f1'));
  assert.deepEqual(result.slices.map((slice) => slice.files), [[], []]);
  assert.equal(summaryLine(result.slices, threads, reading, result.problems), 'Reading shot.png…');
});

test('files between tags belong to their own split slice instead of joining a group', () => {
  const result = plan([[tag('A'), file(), tag('B'), text(' second')]]);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.slices.map((slice) => [slice.paneId, slice.text, slice.group]), [
    ['A', '[Image1: shot.png]', false], ['B', 'second', false],
  ]);
});

test('stale overrides block instead of silently reverting to the default', () => {
  const result = plan([[tag('A'), text(' hi')]], { overrides: new Map([['A', 'removed-id']]) });
  assert.ok(result.problems.some((p) => p.kind === 'unknown-agent' && p.name === 'removed-id'));
  assert.equal(summaryLine(result.slices, threads), "To 1 thread · 1 can't receive");
});

test('missing image metadata blocks instead of silently dropping the attachment', () => {
  assert.ok(plan([[tag('A'), file('gone')]]).problems.some((p) => p.kind === 'unresolved' && p.line === 0));
});

test('planning does not mutate the draft, thread defaults, overrides or file state', () => {
  const input = { doc: [[tag('A'), text('@muck hi '), file()]], threads, files, overrides: new Map([['A', 'null-id']]) };
  const before = structuredClone(input);
  planSend(input);
  assert.deepEqual(input, before);
});
