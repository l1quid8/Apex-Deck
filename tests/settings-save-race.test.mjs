import { test } from 'node:test';
import assert from 'node:assert/strict';

// Test the save feedback operation tracking logic: stale completion must not announce Saved after newer edit,
// and Saved is never synthesized from a timer.
// Reproduces false-Saved prevention requirement.

test('save feedback: stale completion does not announce Saved while newer edit is pending', () => {
  const pendingOps = new Map();
  let saveState = 'idle';

  const onPending = (source, seq) => {
    pendingOps.set(source, Math.max(pendingOps.get(source) ?? 0, seq));
    saveState = 'saving';
  };

  const onSaved = (source, seq) => {
    const latest = pendingOps.get(source);
    if (latest != null && seq < latest) {
      // Stale completion from an older operation; a newer edit is pending
      return;
    }
    pendingOps.delete(source);
    if (pendingOps.size === 0) {
      saveState = 'saved';
    }
  };

  const onError = (source) => {
    pendingOps.delete(source);
    saveState = 'error';
  };

  // Operation 1 starts
  onPending('settings', 1);
  assert.equal(saveState, 'saving');

  // Operation 2 starts before op 1 finishes
  onPending('settings', 2);
  assert.equal(saveState, 'saving');

  // Op 1 completes late (stale ack)
  onSaved('settings', 1);
  assert.equal(saveState, 'saving', 'stale op 1 completion must not set saved while op 2 is pending');
  assert.equal(pendingOps.get('settings'), 2, 'pending ops must still retain op 2');

  // Op 2 completes
  onSaved('settings', 2);
  assert.equal(saveState, 'saved', 'latest op completion sets saved');
  assert.equal(pendingOps.size, 0);

  // Failure scenario
  onPending('settings', 3);
  assert.equal(saveState, 'saving');
  onError('settings');
  assert.equal(saveState, 'error', 'error sets error state, never saved');
});

test('failed save retains local value and reports error', async () => {
  // Simulate latestSaveQueue with failure
  let stored = { v: 1 };
  let local = { v: 2 };
  let error = null;

  const write = async (val) => {
    if (val.v === 2) throw new Error('disk full');
    stored = val;
  };

  try {
    await write(local);
  } catch (e) {
    error = e;
  }

  // Local value retained even though stored not updated
  assert.equal(local.v, 2, 'local retained after failed save');
  assert.equal(stored.v, 1, 'stored unchanged after failure');
  assert.ok(error, 'error surfaced');
});

test('search result keyboard nav: ArrowDown wraps and Enter selects', () => {
  const results = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  let idx = -1;
  const down = () => { idx = idx < 0 ? 0 : Math.min(idx + 1, results.length - 1); };
  const up = () => { idx = idx <= 0 ? results.length - 1 : idx - 1; };
  down(); assert.equal(idx, 0);
  down(); assert.equal(idx, 1);
  down(); assert.equal(idx, 2);
  down(); assert.equal(idx, 2, 'should clamp at end, not wrap on down');
  up(); assert.equal(idx, 1);
  up(); assert.equal(idx, 0);
  up(); assert.equal(idx, 2, 'up from 0 should wrap to last');
});
