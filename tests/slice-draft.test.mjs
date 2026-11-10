import test from 'node:test';
import assert from 'node:assert/strict';
import { addThreadLine, removeThread, restoreRemoved, threadIds, fileIds, readableText, fileReference, encodeClipboard, decodeClipboard } from '../src/sliceDraft.ts';
import { mentionedWords } from '../src/recipients.ts';
import { planSend } from '../src/slicePlan.ts';

const tag = (paneId, hostId = 'host') => ({ kind: 'thread', paneId, hostId });
const text = (value) => ({ kind: 'text', text: value });
const file = (fileId) => ({ kind: 'file', fileId });
const A = tag('a'), B = tag('b'), C = tag('c');
const names = { thread: (id) => id === 'a' ? 'Linux Desktop App' : 'Other', file: (id) => id === 'shot' ? { label: 'Image1', name: '@muck screenshot.png' } : null };
const known = { thread: (id) => ['a', 'b', 'c'].includes(id), file: (id) => id === 'shot' };

test('adding destinations creates separate lines and only the initial tag moves the caret', () => {
  const first = addThreadLine([], A);
  assert.deepEqual(first, { doc: [[A]], caret: { line: 0, offset: 1 } });
  let doc = first.doc;
  for (const ref of [B, C, tag('d')]) {
    const added = addThreadLine(doc, ref);
    assert.equal(added.caret, null);
    doc = added.doc;
  }
  assert.deepEqual(doc, [[A], [B], [C], [tag('d')]]);
  assert.deepEqual(first.doc, [[A]], 'does not mutate the previous draft');
});

test('adding after a group appends a destination line without changing the group', () => {
  assert.deepEqual(addThreadLine([[A, B, text(' hi')]], tag('e')), { doc: [[A, B, text(' hi')], [tag('e')]], caret: null });
});

test('removing a sole destination takes its whole line and restores its original position', () => {
  const doc = [[B], [A, text(' what is the status')], [C]];
  const result = removeThread(doc, 'a');
  assert.deepEqual(result.doc, [[B], [C]]);
  assert.deepEqual(result.removed, { lines: [{ index: 1, tokens: [A, text(' what is the status')] }], replaced: [] });
  assert.deepEqual(restoreRemoved(result.doc, result.removed), doc);
  assert.deepEqual(doc[1], [A, text(' what is the status')]);
});

test('removing a grouped destination keeps the shared words and files for the other destination', () => {
  const doc = [[A, B, text(' hi'), file('shot')]];
  const result = removeThread(doc, 'a');
  assert.deepEqual(result.doc, [[B, text(' hi'), file('shot')]]);
  assert.deepEqual(result.removed, { lines: [], replaced: [{ index: 0, tokens: doc[0] }] });
  assert.deepEqual(restoreRemoved(result.doc, result.removed), doc);
});

test('removing a leading split destination takes only the words and file it owns', () => {
  const doc = [[A, text(' one '), file('shot'), B, text(' two')]];
  const result = removeThread(doc, 'a');
  assert.deepEqual(result.doc, [[B, text(' two')]]);
  assert.deepEqual(restoreRemoved(result.doc, result.removed), doc);
});

test('removing a trailing split destination takes the text before its tag', () => {
  const doc = [[text('one '), A, text(' two '), B]];
  const result = removeThread(doc, 'a');
  assert.deepEqual(result.doc, [[text(' two '), B]]);
  assert.deepEqual(restoreRemoved(result.doc, result.removed), doc);
});

test('mixed removals restore deleted and rewritten lines at their original indices', () => {
  const doc = [[A, text(' first')], [B], [A, C, text(' shared')], [A, text(' last')]];
  const result = removeThread(doc, 'a');
  assert.deepEqual(result.doc, [[B], [C, text(' shared')]]);
  assert.deepEqual(restoreRemoved(result.doc, result.removed), doc);
});

test('removing an ambiguous destination preserves the draft and returns no undo record', () => {
  const doc = [[text('prefix '), A, text(' middle '), B, text(' suffix')]];
  assert.deepEqual(removeThread(doc, 'a'), { doc, removed: null });
  assert.deepEqual(removeThread(doc, 'missing'), { doc, removed: null });
});

test('an ambiguous occurrence prevents partially removing the same destination elsewhere', () => {
  const doc = [[A, text(' safe')], [text('prefix '), A, text(' middle '), B, text(' suffix')]];
  assert.deepEqual(removeThread(doc, 'a'), { doc, removed: null });
});

test('tags surrounding prose without an outside body remain ambiguous', () => {
  const doc = [[A, text(' one '), B]];
  assert.deepEqual(removeThread(doc, 'a'), { doc, removed: null });
});

test('removing a middle split keeps both remaining owners on their original line', () => {
  const doc = [[A, text(' one '), B, text(' two '), C, text(' three')]];
  const result = removeThread(doc, 'b');
  assert.deepEqual(result.doc, [[A, text(' one '), C, text(' three')]]);
  assert.deepEqual(restoreRemoved(result.doc, result.removed), doc);
});

test('removing from a split never shares another destination words with an empty owner', () => {
  const doc = [[A, text(' one '), B, text(' '), C, text(' three')]];
  const result = removeThread(doc, 'a');
  assert.deepEqual(result.doc, [[B, text(' ')], [C, text(' three')]]);
  assert.deepEqual(result.removed.inserted, [1]);
  const threads = new Map([['b', { paneId: 'b', hostId: 'host', title: 'B', open: true, agents: [{ id: 'null', handle: 'null', name: 'Null' }], defaultAgentIds: ['null'] }], ['c', { paneId: 'c', hostId: 'host', title: 'C', open: true, agents: [{ id: 'null', handle: 'null', name: 'Null' }], defaultAgentIds: ['null'] }]]);
  const planned = planSend({ doc: result.doc, threads, files: new Map(), overrides: new Map() });
  assert.deepEqual(planned.slices.map(slice => [slice.paneId, slice.text]), [['b', ''], ['c', 'three']]);
  assert.ok(planned.problems.some(problem => problem.kind === 'empty' && problem.paneId === 'b'));
  assert.deepEqual(restoreRemoved(result.doc, result.removed), doc);
});

test('removing the final populated split leaves individually owned lines instead of ambiguity', () => {
  const doc = [[A, text(' one '), B, text(' '), C, text(' three')]];
  const result = removeThread(doc, 'c');
  assert.deepEqual(result.doc, [[A, text(' one ')], [B, text(' ')]]);
  assert.deepEqual(restoreRemoved(result.doc, result.removed), doc);
});

test('trailing split removal preserves the words before each remaining tag', () => {
  const doc = [[text('one '), A, text(' '), B, text('three '), C]];
  const result = removeThread(doc, 'a');
  assert.deepEqual(result.doc, [[text(' '), B], [text('three '), C]]);
  assert.deepEqual(result.removed.inserted, [1]);
  assert.deepEqual(restoreRemoved(result.doc, result.removed), doc);
});

test('undo accounts for inserted split rows alongside deleted and rewritten original rows', () => {
  const doc = [[A], [A, text(' first '), B, text(' '), C, text(' third')], [B, text(' one '), C, text(' '), A, text(' final')], [A, B, text(' shared')]];
  const result = removeThread(doc, 'a');
  assert.deepEqual(result.doc, [[B, text(' ')], [C, text(' third')], [B, text(' one ')], [C, text(' ')], [B, text(' shared')]]);
  assert.deepEqual(result.removed.inserted, [1, 3]);
  assert.deepEqual(restoreRemoved(result.doc, result.removed), doc);
});

test('selection and file lists deduplicate in first appearance order', () => {
  const doc = [[B, file('two'), A, file('one')], [B, C, file('two')]];
  assert.deepEqual(threadIds(doc), ['b', 'a', 'c']);
  assert.deepEqual(fileIds(doc), ['two', 'one']);
});

test('clipboard plain text uses visible titles and names while same-draft JSON keeps exact tokens', () => {
  const doc = [[A, text(' run the dev server')], [B, file('shot')], []];
  const encoded = encodeClipboard(doc, 'draft', names);
  assert.equal(encoded.plain, '#Linux Desktop App run the dev server\n#Other[Image1: @muck screenshot.png]\n');
  assert.equal(readableText([[A, text(' run the dev server')]], names), '#Linux Desktop App run the dev server');
  assert.deepEqual(decodeClipboard(encoded.json, 'draft', known), doc);
});

test('clipboard rejects other drafts and unknown references', () => {
  const encoded = encodeClipboard([[A, file('shot')]], 'draft', names);
  assert.equal(decodeClipboard(encoded.json, 'other', known), null);
  assert.equal(decodeClipboard(encoded.json, 'draft', { ...known, file: () => false }), null);
  assert.equal(decodeClipboard(encoded.json, 'draft', { ...known, thread: () => false }), null);
});

test('malformed clipboard payloads never become draft tokens', () => {
  for (const json of [
    'invalid', 'null', '[]', '{}',
    '{"version":1,"draftId":"draft","doc":[[null]]}',
    '{"version":1,"draftId":"draft","doc":[[{"kind":"text","text":12}]]}',
    '{"version":1,"draftId":"draft","doc":[[{"kind":"thread","paneId":"a"}]]}',
    '{"version":1,"draftId":"draft","doc":[[{"kind":"file","fileId":12}]]}',
    '{"version":1,"draftId":"draft","doc":[[{"kind":"unknown","text":"word"}]]}',
    '{"version":1,"draftId":"draft","doc":[{}]}',
  ]) {
    assert.equal(decodeClipboard(json, 'draft', known), null, json);
  }
});

test('outgoing file references sanitize names so file names cannot route recipients', () => {
  const reference = fileReference('Image1', '@muck screenshot.png');
  assert.equal(reference, '[Image1: muck-screenshot.png]');
  assert.deepEqual(mentionedWords(reference), []);
  assert.equal(readableText([[file('shot')]], names), '[Image1: @muck screenshot.png]');
});
