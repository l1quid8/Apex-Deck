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

test('an untagged message behind a queued tag follows that tag, as the desktop routes it', async () => {
  const { ParticipantQueues, queuedSticky } = await import('../src/turnQueue.ts');
  const ids = ['null', 'jigga'];
  // The thread still remembers "@everyone": it hasn't heard the queued "@null" yet.
  const thread = async text => text.includes('@null') ? ['null'] : text.includes('@jigga') ? ['jigga'] : ids;
  const sent = [];
  let q;
  q = new ParticipantQueues(async text => queuedSticky(text, ids, 'mention', q.items) ?? thread(text), async (text, to) => sent.push({text,to}), async () => {}, () => {});
  await q.send('@everyone review this');
  await q.send('@null also the tests'); await q.send('and the docs');
  assert.deepEqual(q.items.map(x => x.to), [['null'], ['null']]);
  await q.send('@jigga plan'); assert.deepEqual(q.items.at(-1).to, ['jigga'], 'a typed tag still wins');
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

test('trying again runs the failed bot first, then what was queued for it', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [];
  const q = new ParticipantQueues(async () => ['null'], async (text, _to, kind, hops) => { sent.push({ text, kind, hops }); }, async () => {}, () => {});
  await q.send('@null first');
  q.error('null'); q.idle('null');
  await q.send('@null later');
  assert.deepEqual(sent.map(s => s.text), ['@null first'], 'the failure paused Null');
  q.turn(['null'], null); await tick();
  assert.deepEqual(sent.slice(1), [{ text: '', kind: 'turn', hops: null }]);
  q.idle('null'); await tick();
  assert.deepEqual(sent.map(s => s.text), ['@null first', '', '@null later']);
});

test('a turn for several bots waits until every one is free, then posts once', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [];
  const q = new ParticipantQueues(async text => [text.includes('jigga') ? 'jigga' : 'null'], async (_text, to, kind, hops) => { sent.push({ to, kind, hops }); }, async () => {}, () => {});
  await q.send('@jigga plan');
  q.turn(['null', 'jigga'], 0); await tick();
  assert.deepEqual(sent.map(s => s.kind), ['message']);
  q.idle('jigga'); await tick();
  assert.deepEqual(sent.at(-1), { to: ['null', 'jigga'], kind: 'turn', hops: 0 });
});

test('steering a queued message stops every bot it is for and sends it once, ahead of the rest', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [], stops = [];
  let q;
  q = new ParticipantQueues(async text => text.includes('@all') ? ['jigga', 'null'] : [text.includes('jigga') ? 'jigga' : 'null'], async text => {sent.push(text)}, async id => {stops.push(id); q.idle(id)}, () => {});
  await q.send('@jigga first'); await q.send('@null first'); await q.send('@jigga later'); const id = await q.send('@all both');
  await q.steerQueued(id); await tick();
  assert.deepEqual(stops.sort(), ['jigga', 'null']);
  assert.equal(sent.filter(text => text === '@all both').length, 1);
  assert.equal(sent.at(-1), '@all both'); assert.equal(q.items[0].text, '@jigga later');
});

test('a new message after Stop goes straight out; queued ones still wait', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [];
  const q = new ParticipantQueues(async text => [text.includes('jigga') ? 'jigga' : 'null'], async text => { sent.push(text); }, async () => {}, () => {});
  q.started('null'); await q.send('@null queued'); await q.halt(); q.idle('null'); await tick();
  assert.deepEqual(sent, []); assert.equal(q.items.length, 1);
  q.remove(q.items[0].id); q.started('jigga'); await q.halt(); q.idle('jigga');
  await q.send('@jigga fresh'); await tick();
  assert.deepEqual(sent, ['@jigga fresh']);
});

test('participant steering marks recipients manual while normal messages keep routing provenance', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [];
  const q = new ParticipantQueues(async () => ['null'], async (...args) => { sent.push(args); }, async () => {}, () => {});
  await q.send('ordinary');
  q.idle('null');
  await q.steer('null', 'manual');
  await tick();
  assert.equal(sent[0][4], undefined);
  assert.equal(sent[1][4], true);
});

test('a next step goes to exactly the bot that suggested it, without working out targets', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = []; let asked = 0;
  const q = new ParticipantQueues(async () => { asked++; return ['null']; }, async (text, to, kind, hops, manual) => { sent.push({ text, to, kind, manual }); }, async () => {}, () => {});
  await q.sendTo('commit it', ['jigga']);
  assert.deepEqual(sent, [{ text: 'commit it', to: ['jigga'], kind: 'message', manual: true }]);
  assert.equal(asked, 0);
});
