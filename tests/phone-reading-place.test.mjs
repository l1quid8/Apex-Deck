import test from 'node:test';
import assert from 'node:assert/strict';

// Where a thread opens: back at the reply you were reading, at the newest message, or (while its
// replies are still loading) nowhere yet. A thread must never be left sitting at the top by accident.
const { placeToRestore } = await import(new URL('../src/phone/readingPlace.ts', import.meta.url).href);

const kept = { seq: 5, gap: 40 };

test('a thread with nothing remembered opens at the newest message', () => {
  assert.equal(placeToRestore(undefined, [1, 2, 3]), 'end');
  assert.equal(placeToRestore(undefined, []), 'end');
});

test('the reply you were reading is found again, with how far into it you were', () => {
  assert.deepEqual(placeToRestore(kept, [3, 4, 5, 6, 7]), kept);
});

test('while that reply has not loaded yet, nothing moves', () => {
  assert.equal(placeToRestore(kept, []), 'wait');
  assert.equal(placeToRestore(kept, [1, 2, 3]), 'wait');
});

test('a reply that is gone (taken back, or no longer in the thread) opens at the newest message', () => {
  assert.equal(placeToRestore(kept, [1, 2, 3, 4, 6, 7]), 'end');
});
