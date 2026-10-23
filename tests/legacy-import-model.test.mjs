import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_MARKER, LEDGER_LABELS, applyRequest, confirmWords, fileSize, importableCount, importableLedgers,
  interestingLedgers, isStalePreview, noticeKey, plain, resultLine, resultOutcomes, rowText, shortHash,
  shouldShowNotice, skippedIds, statusWord,
} from '../src/legacyImportModel.ts';

const hash = (seed) => (seed.repeat(64)).slice(0, 64);

function ledger(name, overrides = {}) {
  return {
    ledger: name, sourcePath: `/data/${name}`, size: 2048, sha256: hash('a'), state: 'ready',
    reason: '', counts: { records: 3, importable: 2, notImported: 1 }, records: [], problems: [],
    ...overrides,
  };
}
function preview(ledgers, snapshot = { id: '20261022-204152', path: '/data/legacy-import/20261022-204152', createdAtMs: 1792700000000, reused: false }) {
  return { snapshot, ledgers };
}

test('the imported marker says imported and unverified, never verified', () => {
  assert.equal(LEGACY_MARKER, 'Imported · unverified');
  assert.ok(!/^verified$/i.test(LEGACY_MARKER));
});

test('the notice appears only when something is importable', () => {
  const ready = preview([ledger('assistant-tasks-v1.json')]);
  assert.equal(shouldShowNotice(ready, '/data', null), true);

  // Already imported: the host reports the file as imported, nothing to offer.
  const imported = preview([ledger('assistant-tasks-v1.json', { state: 'imported', counts: { records: 3, importable: 0, notImported: 3 } })]);
  assert.equal(shouldShowNotice(imported, '/data', null), false);

  // Ready but every record is already accounted for.
  const nothingNew = preview([ledger('assistant-tasks-v1.json', { counts: { records: 3, importable: 0, notImported: 3 } })]);
  assert.equal(shouldShowNotice(nothingNew, '/data', null), false);

  // Unreadable files are listed in the screen but are not an invitation to import.
  const unreadable = preview([ledger('assistant-tasks-v1.json', { state: 'unreadable', sha256: undefined, counts: { records: 0, importable: 0, notImported: 0 } })]);
  assert.equal(shouldShowNotice(unreadable, '/data', null), false);
});

test('dismissal is remembered for the exact saved files and comes back when they change', () => {
  const first = preview([ledger('assistant-tasks-v1.json')]);
  const dismissed = noticeKey('/data', first);
  assert.equal(shouldShowNotice(first, '/data', dismissed), false, 'the same files stay dismissed');

  // The old files changed: a new hash is a new question for the person.
  const changed = preview([ledger('assistant-tasks-v1.json', { sha256: hash('b') })]);
  assert.equal(shouldShowNotice(changed, '/data', dismissed), true);

  // A different data folder is a different install, so ask again.
  assert.equal(shouldShowNotice(first, '/other-data', dismissed), true);

  // Same content, different ledger order: still dismissed.
  const ordered = preview([ledger('assistant-conversations-v1.json', { sha256: hash('c') }), ledger('assistant-tasks-v1.json')]);
  const orderedKey = noticeKey('/data', ordered);
  const reversed = preview([ledger('assistant-tasks-v1.json'), ledger('assistant-conversations-v1.json', { sha256: hash('c') })]);
  assert.equal(noticeKey('/data', reversed), orderedKey);
  assert.equal(shouldShowNotice(reversed, '/data', orderedKey), false);

  // One new file beside a dismissed one re-surfaces the notice.
  const added = preview([ledger('assistant-tasks-v1.json'), ledger('personal-assistants.json', { sha256: hash('d') })]);
  assert.equal(shouldShowNotice(added, '/data', dismissed), true);
});

test('counts come from what can actually be imported', () => {
  const shown = preview([
    ledger('assistant-tasks-v1.json', { counts: { records: 7, importable: 5, notImported: 2 } }),
    ledger('assistant-conversations-v1.json', { counts: { records: 32, importable: 0, notImported: 32 }, state: 'imported' }),
    ledger('room-authority-v1.json', { counts: { records: 4, importable: 4, notImported: 0 } }),
  ]);
  assert.deepEqual(importableLedgers(shown).map((l) => l.ledger), ['assistant-tasks-v1.json', 'room-authority-v1.json']);
  assert.equal(importableCount(shown), 9);
  assert.equal(confirmWords(shown), 'Import 9 records');
  assert.equal(confirmWords(preview([ledger('assistant-tasks-v1.json', { counts: { records: 1, importable: 1, notImported: 0 } })])), 'Import 1 record');
});

test('a file with nothing importable still appears when it has records or problems', () => {
  const shown = preview([
    ledger('assistant-tasks-v1.json', { state: 'imported', counts: { records: 7, importable: 0, notImported: 7 } }),
    ledger('assistant-conversations-v1.json', { state: 'missing', counts: { records: 0, importable: 0, notImported: 0 } }),
    ledger('room-authority-v1.json', { state: 'unreadable', sha256: undefined, counts: { records: 0, importable: 0, notImported: 0 }, problems: [{ id: '/data/rooms/x.json', reason: 'Unreadable.' }] }),
  ]);
  assert.deepEqual(interestingLedgers(shown).map((l) => l.ledger), ['assistant-tasks-v1.json', 'room-authority-v1.json']);
});

test('a row shows what it was, what it becomes, and why', () => {
  const queued = rowText({ id: 'legacy-3', kind: 'task', title: 'Sort the invoices', originalStatus: 'queued', importStatus: 'interrupted', reason: 'It will not run until you start it again.' });
  assert.equal(queued.title, 'Sort the invoices');
  assert.equal(queued.change, 'queued → stopped');
  assert.equal(queued.reason, 'It will not run until you start it again.');
  assert.equal(queued.blocked, false);

  const kept = rowText({ id: 'legacy-r1', kind: 'rule', title: 'Always allow shell', originalStatus: 'approved', importStatus: 'skipped', reason: 'Rules are not carried over, so this asks you again.' });
  assert.equal(kept.change, 'approved → not imported');
  assert.equal(kept.blocked, true);

  const unknown = rowText({ id: 'legacy-x', kind: 'history', title: '', originalStatus: 'weirdState', importStatus: 'legacy', reason: '' });
  assert.equal(unknown.title, 'Untitled record');
  assert.equal(unknown.change, 'weirdState → old copy');
});

test('host internals never reach the screen', () => {
  const row = rowText({
    id: 'legacy-1', kind: 'conversation', title: 'Plan the move', originalStatus: 'legacy', importStatus: 'legacy',
    reason: 'This ledger was already imported from different legacy content (source 9a7405e0). Its current legacy file stays in the snapshot but is not imported again.',
  });
  const shown = [row.title, row.change, row.reason, ...Object.values(LEDGER_LABELS), resultLine({ snapshot: 's', complete: true, ledgers: [] }), confirmWords(preview([ledger('assistant-tasks-v1.json')]))].join(' ');
  for (const banned of ['broker', 'ledger', 'provenance', 'snapshot']) {
    assert.ok(!new RegExp(banned, 'i').test(shown), `"${banned}" must not reach the screen: ${shown}`);
  }
  assert.match(row.reason, /file was already imported/);
});

test('plain and status words keep unknown host words instead of dropping them', () => {
  assert.equal(plain('  Two  '), 'Two');
  assert.equal(statusWord('queued'), 'queued');
  assert.equal(statusWord('proposed'), 'waiting for you');
  assert.equal(statusWord('Interrupted'), 'Interrupted');
  assert.equal(statusWord(''), 'unknown');
});

test('the apply is bound to exactly the previewed hashes', () => {
  const shown = preview([
    ledger('assistant-tasks-v1.json', { sha256: hash('1') }),
    ledger('assistant-conversations-v1.json', { sha256: hash('2') }),
    ledger('personal-machine.json', { sha256: hash('3'), counts: { records: 2, importable: 2, notImported: 0 } }),
  ]);
  // Machine permissions are never importable by this host version.
  const request = applyRequest(shown);
  assert.deepEqual(request.ledgers, ['assistant-tasks-v1.json', 'assistant-conversations-v1.json']);
  assert.deepEqual(request.sources, { 'assistant-tasks-v1.json': hash('1'), 'assistant-conversations-v1.json': hash('2') });
});

test('a file this host cannot import is never offered', () => {
  const shown = preview([ledger('personal-machine.json', { sha256: hash('3'), counts: { records: 2, importable: 2, notImported: 0 } })]);
  assert.deepEqual(importableLedgers(shown), []);
  assert.equal(shouldShowNotice(shown, '/data', null), false);
  assert.throws(() => applyRequest(shown), /nothing to import/i);
  // Still listed, so the person can see why it stays behind.
  assert.deepEqual(interestingLedgers(shown).map((l) => l.ledger), ['personal-machine.json']);
});

test('a preview with nothing ready cannot be applied', () => {
  assert.throws(() => applyRequest(preview([ledger('assistant-tasks-v1.json', { state: 'imported', counts: { records: 1, importable: 0, notImported: 1 } })])), /nothing to import/i);
  // A ready file with no hash cannot be bound, so it is not offered.
  assert.throws(() => applyRequest(preview([ledger('assistant-tasks-v1.json', { sha256: undefined })])), /nothing to import/i);
});

test('only the host stale-preview refusal counts as stale', () => {
  assert.equal(isStalePreview(new Error('The legacy snapshot changed after the preview (assistant-tasks-v1.json). Nothing was imported; preview again.')), true);
  assert.equal(isStalePreview('The legacy snapshot changed after the preview (x).'), true);
  assert.equal(isStalePreview(new Error('There is nothing to import. Preview again.')), false);
  assert.equal(isStalePreview(new Error('This machine is not allowed to write.')), false);
  assert.equal(isStalePreview(undefined), false);
  assert.equal(isStalePreview({ message: 'changed after the preview' }), false, 'a plain object is not an Error');
});

test('the result lists what came in and what was left behind', () => {
  const result = {
    snapshot: '20261022-204152', complete: true,
    ledgers: [
      { ledger: 'assistant-tasks-v1.json', state: 'imported', imported: 5, skipped: 2, skippedIds: ['legacy-9'], verified: false },
      { ledger: 'assistant-conversations-v1.json', state: 'alreadyImported', imported: 0, skipped: 0, verified: false },
      { ledger: 'room-authority-v1.json', state: 'failed', imported: 0, skipped: 0, verified: false, error: 'The broker refused the write.' },
    ],
  };
  assert.equal(resultLine(result), 'Imported 5 records, 2 left behind, 1 file failed.');
  const outcomes = resultOutcomes(result);
  assert.deepEqual(outcomes.map((row) => row.label), ['Tasks', 'Conversations', 'Group chats']);
  assert.equal(outcomes[0].imported, 5);
  assert.equal(outcomes[2].failed, true);
  assert.ok(!/broker/i.test(outcomes[2].error), 'a failed file reason is shown without internals');
  assert.deepEqual(skippedIds(result), ['legacy-9']);
  assert.equal(resultLine({ snapshot: 's', complete: true, ledgers: [{ ledger: 'assistant-tasks-v1.json', state: 'imported', imported: 1, skipped: 0, verified: false }] }), 'Imported 1 record.');
});

test('source fingerprints and sizes are short enough to compare on screen', () => {
  const full = hash('9a7405e0');
  assert.equal(shortHash(full), `${full.slice(0, 8)}…${full.slice(-4)}`);
  assert.ok(shortHash(full).length < full.length);
  assert.equal(shortHash(undefined), 'no fingerprint');
  assert.equal(fileSize(2048), '2.0 KB');
  assert.equal(fileSize(512), '512 bytes');
  assert.equal(fileSize(23 * 1024 * 1024), '23.0 MB');
});
