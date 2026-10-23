import test from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_IMPORT_CAPABILITY, createLegacyImportClient } from '../src/legacyImport.ts';

const sha = c => c.repeat(64);
const row = (id, kind, original, imported) => ({ id, kind, title: `Title ${id}`, originalStatus: original, importStatus: imported, reason: 'Why' });
const preview = (overrides = {}) => ({
  snapshot: { id: '20261022-101501', path: '/data/legacy-import/20261022-101501', createdAtMs: 1000, reused: false },
  ledgers: [
    { ledger: 'assistant-tasks-v1.json', sourcePath: '/data/assistant-tasks-v1.json', size: 10, sha256: sha('a'), state: 'ready', reason: 'Ready',
      counts: { records: 1, importable: 1, notImported: 1 }, records: [row('task-1', 'task', 'queued', 'proposed')], problems: [{ id: 'exec', reason: 'Not restored' }] },
    { ledger: 'assistant-conversations-v1.json', sourcePath: '/data/assistant-conversations-v1.json', size: 10, sha256: sha('b'), state: 'imported', reason: 'Done',
      counts: { records: 1, importable: 1, notImported: 0 }, records: [row('req-1', 'conversation', 'completed', 'legacy')], problems: [] },
    { ledger: 'room-authority-v1.json', sourcePath: '/data/saved-chats-v1/rooms', size: 10, sha256: sha('c'), state: 'ready', reason: 'Ready',
      counts: { records: 1, importable: 1, notImported: 0 }, records: [row('room', 'room', 'noManifest', 'restorable')], problems: [] },
    { ledger: 'personal-assistants.json', sourcePath: '/data/saved-chats-v1/personal-assistants.json', size: 0, state: 'missing', reason: 'No legacy file.',
      counts: { records: 0, importable: 0, notImported: 0 }, records: [], problems: [] },
  ],
  ...overrides,
});
const applied = { snapshot: '20261022-101501', complete: true, ledgers: [
  { ledger: 'assistant-tasks-v1.json', state: 'imported', imported: 1, skipped: 0, verified: true, importedAtMs: 2000, error: null },
  { ledger: 'room-authority-v1.json', state: 'imported', imported: 1, skipped: 0, verified: true, importedAtMs: 2000, error: null },
] };

function route({ capable = true, answers = {} } = {}) {
  const calls = [];
  return { calls, supports: capability => capable && capability === LEGACY_IMPORT_CAPABILITY,
    call: async (command, args) => { calls.push([command, args]); return structuredClone(answers[command]); } };
}

test('without the host capability nothing is sent and the reason is explained', async () => {
  const r = route({ capable: false });
  const client = createLegacyImportClient({ route: r });
  assert.match(client.unavailable(), /update/i);
  await assert.rejects(client.preview(), /update/i);
  assert.deepEqual(r.calls, []);
});

test('preview is read-only and its rows are checked', async () => {
  const r = route({ answers: { legacy_import_preview: preview() } });
  const result = await createLegacyImportClient({ route: r }).preview();
  assert.deepEqual(r.calls, [['legacy_import_preview', {}]]);
  assert.equal(result.ledgers[0].records[0].importStatus, 'proposed');
  const broken = preview(); broken.ledgers[0].records[0].kind = 'shell';
  await assert.rejects(createLegacyImportClient({ route: route({ answers: { legacy_import_preview: broken } }) }).preview(), /invalid/i);
});

test('apply binds exactly the previewed hashes of ready ledgers', async () => {
  const r = route({ answers: { legacy_import_apply: applied } });
  const client = createLegacyImportClient({ route: r });
  const result = await client.apply(preview());
  assert.equal(result.complete, true);
  assert.deepEqual(r.calls, [['legacy_import_apply', { snapshot: '20261022-101501', sources: { 'assistant-tasks-v1.json': sha('a'), 'room-authority-v1.json': sha('c') } }]]);
  await client.apply(preview(), ['room-authority-v1.json']);
  assert.deepEqual(r.calls[1][1].sources, { 'room-authority-v1.json': sha('c') });
  await assert.rejects(client.apply(preview(), ['assistant-conversations-v1.json']), /not ready/i);
  await assert.rejects(client.apply(preview({ snapshot: null })), /nothing/i);
  assert.equal(r.calls.length, 2, 'refused applies send nothing');
});

test('history is always labelled unverified', async () => {
  const history = { snapshot: '20261022-101501', requestId: 'req-1', sourceSha256: sha('b'), verified: false, label: 'Legacy', record: { request: { text: 'hi' } } };
  const client = createLegacyImportClient({ route: route({ answers: { legacy_import_history: history } }) });
  assert.equal((await client.history('20261022-101501', 'req-1')).verified, false);
  const forged = createLegacyImportClient({ route: route({ answers: { legacy_import_history: { ...history, verified: true } } }) });
  await assert.rejects(forged.history('20261022-101501', 'req-1'), /unverified/i);
});

test('personal preview kinds and exact personal hash can be imported while grants stay excluded', async () => {
  const p = preview();
  p.ledgers[3] = { ...p.ledgers[3], size: 100, state: 'ready', sha256: sha('d'),
    counts: { records: 8, importable: 1, notImported: 1 },
    records: ['assistant', 'memory', 'schedule', 'rule', 'approval', 'grant', 'personalTask', 'history'].map((kind, i) => row(String(i), kind, 'saved', 'legacy')) };
  const r = route({ answers: { legacy_import_preview: p, legacy_import_apply: { ...applied, ledgers: [
    { ledger: 'personal-assistants.json', state: 'imported', imported: 1, skipped: 1, skippedIds: ['assistant:existing'], verified: true }
  ] } } });
  const client = createLegacyImportClient({ route: r });
  const current = await client.preview();
  const result = await client.apply(current, ['personal-assistants.json']);
  assert.deepEqual(r.calls[1][1].sources, { 'personal-assistants.json': sha('d') });
  assert.deepEqual(result.ledgers[0].skippedIds, ['assistant:existing']);
  r.call = async () => ({ ...applied, ledgers: [{ ...applied.ledgers[0], skippedIds: [42] }] });
  await assert.rejects(client.apply(current), /invalid/i);
});
