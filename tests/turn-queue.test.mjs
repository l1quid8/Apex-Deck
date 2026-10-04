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

test('participant queues let idle Jigga start while Null works', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [];
  const q = new ParticipantQueues(async text => [text.includes('jigga') ? 'jigga' : 'null'], async (text, to) => sent.push({text,to}), async () => {}, () => {});
  await q.send('@null first'); await q.send('@null later'); await q.send('@jigga plan');
  assert.deepEqual(sent.map(x=>x.text), ['@null first', '@jigga plan']);
  q.idle('null'); await tick();
  assert.deepEqual(sent.map(x=>x.text), ['@null first', '@jigga plan', '@null later']);
});

test('steering and stopping Null preserve Jigga and its queue', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [], stops = [];
  let q;
  q = new ParticipantQueues(async text => [text.includes('jigga') ? 'jigga' : 'null'], async text => {sent.push(text)}, async id => {stops.push(id); q.idle(id)}, () => {});
  await q.send('@null first'); await q.send('@jigga first'); await q.send('@jigga later');
  await q.steer('null', '@null steer'); await tick();
  assert.deepEqual(stops, ['null']); assert.equal(q.state.jigga, 'working');
  assert.equal(q.items[0].text, '@jigga later'); assert.ok(sent.includes('@null steer'));
  await q.halt('null'); assert.equal(q.items[0].text, '@jigga later');
});

test('failure pauses only the failed participant', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [];
  const q = new ParticipantQueues(async text => [text.includes('jigga') ? 'jigga' : 'null'], async text => {sent.push(text); if(text==='@null fail') throw Error('offline')}, async()=>{}, ()=>{});
  await q.send('@null fail'); await q.send('@null later'); await q.send('@jigga plan');
  assert.deepEqual(sent, ['@null fail', '@jigga plan']); assert.equal(q.items.length, 1);
});

test('compaction waits for all models and blocks new participant turns until settled', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = []; let release;
  const q = new ParticipantQueues(async text => [text.includes('jigga') ? 'jigga' : 'null'], async (text, _to, kind) => { sent.push(text); if(kind==='compact') await new Promise(r=>release=r); }, async()=>{}, ()=>{});
  await q.send('@null first'); await q.send('/compact','compact');
  q.idle('null'); await tick();
  await q.send('@jigga later'); assert.deepEqual(sent, ['@null first', '/compact']);
  release(); await tick(); assert.deepEqual(sent, ['@null first', '/compact', '@jigga later']);
});
