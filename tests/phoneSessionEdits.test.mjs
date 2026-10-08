import test from 'node:test';
import assert from 'node:assert/strict';
import { serialEdits, stopProjectPanes } from '../src/phone/sessionEdits.ts';
import { readFileSync } from 'node:fs';

test('concurrent restorations load after the preceding save and failures do not block later edits', async () => {
  const run = serialEdits();
  let saved = [];
  const restore = id => run(async () => {
    const fresh = [...saved];
    await new Promise(resolve => setTimeout(resolve, 5));
    saved = [...fresh, id];
  });
  await Promise.all([restore('a'), restore('b')]);
  assert.deepEqual(saved, ['a', 'b']);
  await assert.rejects(run(async () => { throw Error('offline'); }));
  await restore('c');
  assert.deepEqual(saved, ['a', 'b', 'c']);
});

test('removal clears phone queues before stopping chats and terminals, never deleting history', async () => {
  const calls = [];
  const backend = { roomClose: async id => calls.push(`room:${id}`), ptyKill: async id => calls.push(`pty:${id}`) };
  await stopProjectPanes([{id:'a',kind:'chat'}, {id:'b',kind:'terminal'}, {id:'c',kind:'preview'}], backend, id => calls.push(`clear:${id}`));
  assert.deepEqual(calls, ['clear:a', 'clear:b', 'clear:c', 'room:a', 'pty:b']);
});

test('failed shutdown rejects removal instead of silently removing saved rows', async () => {
  await assert.rejects(stopProjectPanes([{id:'a',kind:'chat'}], {roomClose: async () => { throw Error('offline'); }}, () => {}), /offline/);
});

test('message context menus capture link holds before the rich text link menu', () => {
  const source = readFileSync(new URL('../src/phone/PhoneApp.tsx', import.meta.url), 'utf8');
  assert.match(source, /onContextMenuCapture/);
  assert.match(source, /event\.stopPropagation\(\)/);
});

test('retired phone queues reject pending sends and cannot drain on idle or resume', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const queues = new Map();
  let resolveTargets;
  const targets = new Promise(resolve => { resolveTargets = resolve; });
  const sent = [];
  const queue = new ParticipantQueues(() => targets, async text => sent.push(text), async () => {}, () => {}, () => {}, () => queues.get('a') === queue);
  queues.set('a', queue);
  const pending = queue.send('pending');
  await Promise.resolve();
  queues.delete('a');
  queue.availabilityChanged();
  resolveTargets(['bot']);
  await assert.rejects(pending, /nothing was queued/);
  queue.idle('bot');
  queue.resume();
  assert.deepEqual(sent, []);
  assert.deepEqual(queue.items, []);
});
