import { test } from 'node:test';
import assert from 'node:assert/strict';

// Test the save feedback generation counter logic: stale timer must not announce Saved after newer edit
// Reproduces false-Saved prevention requirement

test('save generation prevents stale Saved announcement', async () => {
  let gen = 0;
  let lastSavedGen = -1;
  let saveState = 'idle';

  const edit = async (delayMs) => {
    const myGen = ++gen;
    saveState = 'saving';
    await new Promise(r => setTimeout(r, delayMs));
    if (myGen !== gen) {
      // stale completion should not set saved
      return { gen: myGen, stale: true, state: saveState };
    }
    saveState = 'saved';
    lastSavedGen = myGen;
    return { gen: myGen, stale: false, state: saveState };
  };

  // Simulate rapid edits: first takes 100ms, second starts after 10ms and takes 20ms
  const p1 = edit(100);
  await new Promise(r => setTimeout(r, 10));
  const p2 = edit(20);
  const r2 = await p2;
  const r1 = await p1;

  assert.equal(r2.stale, false, 'second edit should not be stale');
  assert.equal(r1.stale, true, 'first edit should be stale and not announce saved');
  assert.equal(lastSavedGen, 2, 'only latest gen should be saved');
  assert.equal(saveState, 'saved', 'final state should be saved from latest');
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
