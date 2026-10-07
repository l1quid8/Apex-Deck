import test from 'node:test';
import assert from 'node:assert/strict';
import { latestSaveQueue } from '../src/settingsSave.ts';

test('settings writes stay ordered and coalesce to the newest pending selection', async () => {
  const writes = [];
  const release = [];
  const queue = latestSaveQueue(value => {
    writes.push(value);
    return new Promise(resolve => release.push(resolve));
  });
  const first = queue('low');
  const second = queue('medium');
  const last = queue('high');
  assert.deepEqual(writes, ['low']);
  release.shift()();
  await first;
  assert.deepEqual(writes, ['low', 'high']);
  release.shift()();
  await Promise.all([second, last]);
  assert.deepEqual(writes, ['low', 'high']);
});

test('a failed write does not strand the newer selection', async () => {
  let rejectFirst;
  const writes = [];
  const queue = latestSaveQueue(value => {
    writes.push(value);
    return value === 'low' ? new Promise((_, reject) => { rejectFirst = reject; }) : Promise.resolve();
  });
  const first = queue('low');
  const last = queue('high');
  rejectFirst(new Error('offline'));
  await assert.rejects(first, /offline/);
  await last;
  assert.deepEqual(writes, ['low', 'high']);
});
