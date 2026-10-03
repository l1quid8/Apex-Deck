import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnQueue } from '../src/turnQueue.ts';
const tick = () => new Promise(r => setTimeout(r, 0));
test('queued messages wait, can be edited or removed, and run in order', async () => {
  let release; const sent = []; const snapshots = [];
  const q = new TurnQueue(async text => { sent.push(text); if (text === 'first') await new Promise(r => release = r); }, async () => {}, items => snapshots.push(items));
  q.send('first'); const second = q.send('second'); const third = q.send('third');
  q.edit(second, 'edited'); q.remove(third); assert.deepEqual(sent, ['first']);
  release(); await tick(); assert.deepEqual(sent, ['first', 'edited']); assert.deepEqual(snapshots.at(-1), []);
});
test('steer stops the active turn and takes priority without overlapping turns', async () => {
  let release; let active = 0; const sent = [];
  const q = new TurnQueue(async text => { assert.equal(active++, 0); sent.push(text); if(text === 'first') await new Promise(r => release = r); active--; }, async () => release(), () => {});
  q.send('first'); q.send('queued'); await q.steer('@other take over'); await tick();
  assert.deepEqual(sent, ['first', '@other take over', 'queued']);
});
test('a failed message pauses queued work and retains it', async () => {
  let reject; const errors=[];
  const q = new TurnQueue(() => new Promise((_, r) => reject=r), async()=>{}, ()=>{}, e=>errors.push(e));
  q.send('first'); q.send('later'); reject(new Error('offline')); await tick();
  assert.equal(q.items.length,1); assert.equal(q.items[0].text,'later'); assert.equal(errors.length,1);
});
test('a failed stop retains the steering message for retry', async () => {
  let release; const errors = [];
  const q = new TurnQueue(() => new Promise(r => release = r), async () => { throw new Error('stop failed'); }, () => {}, e => errors.push(e));
  q.send('first'); q.send('later'); await q.steer('@other take over');
  assert.deepEqual(q.items.map(item => item.text), ['@other take over', 'later']);
  assert.equal(q.paused, true); assert.equal(errors.length, 1);
  release(); await tick();
});

test('literal command text cannot become compaction without explicit kind', async () => {
  const sent = [];
  const q = new TurnQueue(async (text, kind) => sent.push({text,kind}), async()=>{}, ()=>{});
  q.paused = true;
  const id = q.send('/compact');
  q.send('/compact', 'compact');
  q.edit(id, '/clear');
  q.resume(); await tick();
  assert.deepEqual(sent, [{text:'/clear',kind:'message'}, {text:'/compact',kind:'compact'}]);
});
