import test from 'node:test';
import assert from 'node:assert/strict';
import { createThreadCopies, loadRetryDelay, withDeadline, LoadTimeout, copyAge } from '../src/phone/threadCopies.ts';

test('keeps the last copies, dropping the one opened longest ago', () => {
  const copies = createThreadCopies(3);
  copies.put('a', 1); copies.put('b', 2); copies.put('c', 3);
  copies.put('a', 10); // opened again: now the newest
  copies.put('d', 4);
  assert.equal(copies.get('b'), undefined);
  assert.equal(copies.get('a').value, 10);
  assert.deepEqual(['a', 'c', 'd'].map((key) => copies.get(key)?.value), [10, 3, 4]);
  assert.equal(copies.size, 3);
});

test('a copy remembers when it was kept', () => {
  const copies = createThreadCopies();
  copies.put('a', 'x', 5000);
  assert.equal(copies.get('a').at, 5000);
  assert.equal(copyAge(12_400), '12 s ago');
  assert.equal(copyAge(180_000), '3 min ago');
});

test('a failed load waits 2, 4, 8 and then 15 s before each new try', () => {
  assert.deepEqual([1, 2, 3, 4, 9].map(loadRetryDelay), [2000, 4000, 8000, 15000, 15000]);
});

test('a load with no answer by its deadline fails, and a late answer is ignored', async () => {
  let answer;
  const slow = new Promise((resolve) => { answer = resolve; });
  const timers = { setTimeout: (fn) => { timers.fire = fn; return 1; }, clearTimeout: () => { timers.fire = null; } };
  const late = withDeadline(slow, 10_000, timers);
  timers.fire();
  await assert.rejects(late, (error) => error instanceof LoadTimeout && /No answer after 10 s/.test(error.message));
  answer('too late');
});

test('a load that answers in time passes straight through', async () => {
  assert.equal(await withDeadline(Promise.resolve('thread'), 10_000), 'thread');
  await assert.rejects(withDeadline(Promise.reject(new Error('refused')), 10_000), /refused/);
});
