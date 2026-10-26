import test from 'node:test';
import assert from 'node:assert/strict';
import { restartQuestion, restartQuestions, resultNotice, updateNote } from '../src/updates.ts';
import { assistantsRunning } from '../src/closing.ts';

const base = { current: '0.9.0', state: 'idle', disabledReason: null, available: null, progress: null, error: null, checkedAt: null, dismissed: false, result: null };
const now = 10 * 60_000;

test('the Settings line says plainly where updating stands', () => {
  assert.equal(updateNote(null, now), '');
  assert.equal(updateNote({ ...base, state: 'up-to-date', checkedAt: now - 5 * 60_000 }, now), 'Apex Deck 0.9.0. Up to date, checked 5 min ago.');
  assert.equal(updateNote({ ...base, state: 'downloading', available: { version: '0.9.1', notes: '' }, progress: { received: 52_428_800, total: 209_715_200 } }, now), 'Apex Deck 0.9.0. Downloading 0.9.1… 25% of 200 MB');
  assert.equal(updateNote({ ...base, state: 'verifying', available: { version: '0.9.1', notes: '' } }, now), 'Apex Deck 0.9.0. Checking the download of 0.9.1…');
  assert.match(updateNote({ ...base, state: 'ready', available: { version: '0.9.1', notes: '' } }, now), /0\.9\.1 is ready\. Restarting installs it; Deck reopens by itself\.$/);
  assert.match(updateNote({ ...base, state: 'ready', available: { version: '0.9.1', notes: '' }, error: 'An update is already being installed.' }, now), /Last try: An update is already/);
  assert.equal(updateNote({ ...base, state: 'error', error: 'offline' }, now), "Apex Deck 0.9.0. Couldn't update: offline");
  assert.equal(updateNote({ ...base, state: 'disabled', disabledReason: 'Development builds don’t update themselves.' }, now), 'Apex Deck 0.9.0. Development builds don’t update themselves.');
  for (const state of ['idle', 'checking', 'installing']) assert.ok(!updateNote({ ...base, state, available: { version: '0.9.1', notes: '' } }, now).includes('undefined'));
});

test('after reopening, Deck says once how the update went', () => {
  assert.equal(resultNotice({ ...base, result: null }), null);
  assert.deepEqual(resultNotice({ ...base, result: { outcome: 'installed', version: '0.9.1' } }), { text: 'Updated to Apex Deck 0.9.1.', problem: false });
  assert.deepEqual(resultNotice({ ...base, result: { outcome: 'installed', version: '0.9.1', message: 'Its service in another account didn\'t start again.' } }), { text: "Updated to Apex Deck 0.9.1. Its service in another account didn't start again.", problem: true });
  assert.deepEqual(resultNotice({ ...base, result: { outcome: 'failed', version: '0.9.1', message: 'offline' } }), { text: "The update to 0.9.1 didn't install, and nothing was changed: offline", problem: true });
  assert.equal(resultNotice({ ...base, result: { outcome: 'needs-attention', version: '0.9.1', message: 'x' } }).problem, true);
});

test('restarting to update asks about busy agents even where quitting would not stop them', () => {
  assert.equal(restartQuestion([]), null);
  const asked = restartQuestion([{ name: 'Jigga', thread: 'Auto update', workspace: 'apex-deck', state: 'replying' }]);
  assert.equal(asked.action, 'Restart and end them');
  assert.match(asked.body, /background service/);
  assert.match(asked.body, /phones/);
  assert.deepEqual(asked.rows, ['Jigga in Auto update · apex-deck · Replying']);
});

test('restarting to update asks first about unsaved file edits, which the quit would drop without the editor’s warning', () => {
  assert.deepEqual(restartQuestions(null, []), []);
  const [discard] = restartQuestions('notes.md', []);
  assert.equal(discard.title, 'Discard unsaved changes to notes.md?');
  assert.equal(discard.action, 'Discard');
  const busy = [{ name: 'Jigga', thread: 'Auto update', workspace: 'apex-deck', state: 'replying' }];
  assert.deepEqual(restartQuestions('notes.md', busy).map((q) => q.action), ['Discard', 'Restart and end them']);
  assert.deepEqual(restartQuestions(null, busy).map((q) => q.action), ['Restart and end them']);
});

test('restarting to update asks when only personal Assistant work is going', () => {
  const asked = restartQuestions(null, assistantsRunning([{ name: 'Dot', onThisMac: true, offline: false, personalTasks: [{ goal: 'Back up the photos', status: 'running' }], events: [] }], 'mac'));
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].rows, ['Dot · Back up the photos · Working']);
});
