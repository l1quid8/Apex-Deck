import test from 'node:test';
import assert from 'node:assert/strict';
import { ParticipantQueues, queuedSticky } from '../src/turnQueue.ts';

const people = [{ id: 'null', display_name: 'Null' }, { id: 'muck', display_name: 'Muck' }];
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a queued one-send pick never becomes the next untagged message default', async () => {
  const posted = [];
  let q;
  q = new ParticipantQueues(async text => queuedSticky(text, people, 'mention', q.items) ?? ['muck'],
    async (text, to, _kind, _hops, _voice, oneOff) => posted.push({text, to, oneOff}), async () => {}, () => {});
  q.started('null'); q.started('muck');
  await q.sendOnce('check this', ['null']);
  await q.send('and this');
  assert.deepEqual(q.items.map(item => ({text: item.text, to: item.to, oneOff: item.oneOff})), [
    {text: 'check this', to: ['null'], oneOff: true}, {text: 'and this', to: ['muck'], oneOff: undefined},
  ]);
  q.idle('null'); q.idle('muck'); await tick();
  assert.deepEqual(posted, [
    {text: 'check this', to: ['null'], oneOff: true}, {text: 'and this', to: ['muck'], oneOff: undefined},
  ]);
});

test('a one-send pick stays pinned when the room routing changes before dispatch', async () => {
  const posted = [];
  const q = new ParticipantQueues(async () => assert.fail('one-send picks are explicit'), async (text, to) => posted.push({text,to}), async () => {}, () => {}, () => {}, () => true, true, async () => ['muck']);
  q.started('null'); await q.sendOnce('check this', ['null']);
  q.idle('null'); await tick();
  assert.deepEqual(posted, [{text:'check this',to:['null']}]);
});

test('queued sticky routing skips picks and retains the preceding regular tag', () => {
  assert.deepEqual(queuedSticky('and this', people, 'mention', [
    {id:1,text:'@muck first',to:['muck'],kind:'message'},
    {id:2,text:'check this',to:['null'],kind:'message',oneOff:true},
  ]), ['muck']);
});
