import test from 'node:test';
import assert from 'node:assert/strict';
import { panelDrag } from '../src/phone/composerPanelModel.ts';

test('compact panel expands at the upward drag threshold', () => {
  assert.equal(panelDrag('compact', -64), 'expanded');
});

test('compact panel dismisses at the downward drag threshold', () => {
  assert.equal(panelDrag('compact', 64), 'dismiss');
});

test('expanded panel collapses at the downward drag threshold', () => {
  assert.equal(panelDrag('expanded', 64), 'compact');
});

test('sub-threshold drags preserve the current detent', () => {
  assert.equal(panelDrag('compact', -63), 'compact');
  assert.equal(panelDrag('compact', 63), 'compact');
  assert.equal(panelDrag('expanded', -63), 'expanded');
  assert.equal(panelDrag('expanded', 63), 'expanded');
});

test('a canceled gesture preserves the current detent', () => {
  assert.equal(panelDrag('compact', 0), 'compact');
  assert.equal(panelDrag('expanded', 0), 'expanded');
});

test('attachment reads follow captured draft migrations without following visible navigation', async () => {
  const { attachmentTarget } = await import('../src/phone/composerPanelModel.ts');
  assert.equal(attachmentTarget('draft-a', { 'draft-a': 'thread-a' }), 'thread-a');
  assert.equal(attachmentTarget('thread-a', { 'draft-b': 'thread-b' }), 'thread-a');
  assert.equal(attachmentTarget('draft-a', { 'draft-a': 'thread-a', 'thread-a': 'thread-b' }), 'thread-b');
});

test('canceled picker does not enter read state or alter the draft', async () => {
  const { readCapturedFiles } = await import('../src/phone/composerPanelModel.ts');
  let busy = 0; let additions = 0;
  await readCapturedFiles({ capturedId: 'draft', moved: {}, files: [], makeAttachment: async () => ({}), onStart: () => busy++, onAdd: () => additions++, onError: () => assert.fail('cancel cannot fail'), onFinish: () => busy-- });
  assert.equal(busy, 0);
  assert.equal(additions, 0);
});

test('failed reads preserve text and balance the busy state', async () => {
  const { readCapturedFiles } = await import('../src/phone/composerPanelModel.ts');
  const draft = { text: 'keep this text', files: [] };
  let busy = 0; let error = null;
  await readCapturedFiles({ capturedId: 'draft', moved: {}, files: [{ name: 'broken' }], makeAttachment: async () => { throw new Error('read failed'); }, onStart: () => busy++, onAdd: (_id, files) => draft.files.push(...files), onError: (value) => error = value, onFinish: () => busy-- });
  assert.equal(error.message, 'read failed');
  assert.equal(busy, 0);
  assert.equal(draft.text, 'keep this text');
  assert.equal(draft.files.length, 0);
});

test('read completion follows a captured draft migration and preserves duplicate filenames', async () => {
  const { readCapturedFiles } = await import('../src/phone/composerPanelModel.ts');
  const moved = {}; const draft = { text: 'message survives', files: [] }; let target;
  const file = (name, id) => ({ name, arrayBuffer: async () => new Uint8Array([id]).buffer });
  let serial = 0;
  const reading = readCapturedFiles({ capturedId: 'draft-a', moved, files: [file('same.txt', 1), file('same.txt', 2)], makeAttachment: async (item) => ({ id: String(++serial), name: item.name, bytes: new Uint8Array(await item.arrayBuffer()) }), onStart() {}, onAdd(id, files) { target = id; draft.files.push(...files); }, onError(error) { throw error; }, onFinish() {} });
  moved['draft-a'] = 'thread-a';
  await reading;
  assert.equal(target, 'thread-a');
  assert.equal(draft.text, 'message survives');
  assert.deepEqual(draft.files.map((item) => item.name), ['same.txt', 'same.txt']);
  assert.notEqual(draft.files[0].id, draft.files[1].id);
});

test('Plan changes apply the current boolean to the captured room and wait for acknowledgement', async () => {
  const { setPlanBeforeContinuation } = await import('../src/phone/composerPanelModel.ts');
  let release; let continuation = 0; let requested = null;
  const acknowledged = setPlanBeforeContinuation('room-a', false, (roomId, enabled) => { requested = { roomId, enabled }; return new Promise((resolve) => { release = resolve; }); }, async () => { continuation++; });
  assert.deepEqual(requested, { roomId: 'room-a', enabled: false });
  assert.equal(continuation, 0);
  release(); await acknowledged;
  assert.equal(continuation, 1);
  await assert.rejects(setPlanBeforeContinuation('room-a', true, async () => { throw new Error('Plan refused'); }, async () => { continuation++; }), /Plan refused/);
  assert.equal(continuation, 1);
});

test('Plan controls explain sending, offline and read-only disabled states', async () => {
  const { composerPlanDisabledReason } = await import('../src/phone/composerPanelModel.ts');
  assert.equal(composerPlanDisabledReason({ pendingDraft: false, sending: true, online: true, readOnly: false, offlineReason: 'Offline' }), 'Wait for sending to finish.');
  assert.equal(composerPlanDisabledReason({ pendingDraft: false, sending: false, online: false, readOnly: false, offlineReason: 'Machine is offline.' }), 'Machine is offline.');
  assert.equal(composerPlanDisabledReason({ pendingDraft: false, sending: false, online: true, readOnly: true, offlineReason: '' }), 'Plan mode needs chat access on this machine.');
  assert.equal(composerPlanDisabledReason({ pendingDraft: true, sending: false, online: false, readOnly: true, offlineReason: 'Offline' }), null);
});
