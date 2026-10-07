import test from 'node:test';
import assert from 'node:assert/strict';
import { ParticipantQueues } from '../src/turnQueue.ts';
import { giveBack, queueHears, queueSync, queuedViews } from '../src/phoneQueue.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));
const bots = (text) => [text.includes('jigga') ? 'jigga' : 'null'];
const names = { null: 'Null', jigga: 'Jigga' };

test('a message to a working bot waits on the phone and goes once that bot is idle', async () => {
  const sent = [];
  const q = new ParticipantQueues(async (t) => bots(t), async (text, to) => { sent.push({ text, to }); }, async () => {}, () => {});
  queueHears(q, { type: 'turn_started', id: 'null' });
  await q.send('@null second thought');
  await q.send('@jigga plan');
  assert.deepEqual(sent.map((s) => s.text), ['@jigga plan'], 'Jigga is free, Null is not');
  const views = queuedViews(q.items, ['null'], [...q.paused], q.connectionPaused, (id) => names[id], 'Test Mac');
  assert.deepEqual(views.map((v) => [v.line, v.steerable, v.held]), [['Queued for Null', true, false]]);
  queueHears(q, { type: 'participant_idle', id: 'null' }); await tick();
  assert.deepEqual(sent.map((s) => s.text), ['@jigga plan', '@null second thought']);
});

test('Steer now stops the bot and its message goes first, after the cut-off reply', async () => {
  const sent = [], stops = [];
  const q = new ParticipantQueues(async (t) => bots(t), async (text) => { sent.push(text); }, async (id) => { stops.push(id); }, () => {});
  queueHears(q, { type: 'turn_started', id: 'null' });
  await q.send('@null first queued'); await q.send('@null steer this');
  await q.steerQueued(q.items[1].id);
  assert.deepEqual(stops, ['null']);
  assert.deepEqual(sent, [], 'nothing posts until the machine says Null stopped');
  queueHears(q, { type: 'participant_idle', id: 'null' }); await tick();
  assert.deepEqual(sent, ['@null steer this'], 'one at a time: the rest waits for the next idle');
  queueHears(q, { type: 'participant_idle', id: 'null' }); await tick();
  assert.deepEqual(sent, ['@null steer this', '@null first queued']);
});

test('a stopped bot holds what waits for it, and a failed reply pauses it too', async () => {
  const sent = [];
  const q = new ParticipantQueues(async (t) => bots(t), async (text) => { sent.push(text); }, async () => {}, () => {});
  queueHears(q, { type: 'turn_started', id: 'null' });
  await q.send('@null later');
  await q.halt('null');
  queueHears(q, { type: 'participant_idle', id: 'null' }); await tick();
  assert.deepEqual(sent, []);
  assert.equal(queuedViews(q.items, [], [...q.paused], false, (id) => names[id], 'Test Mac')[0].line, 'Paused for Null');
  q.resume('null'); await tick();
  assert.deepEqual(sent, ['@null later']);
  queueHears(q, { type: 'turn_started', id: 'null' });
  await q.send('@null after fail');
  queueHears(q, { type: 'failed', id: 'null', error: 'boom' });
  queueHears(q, { type: 'participant_idle', id: 'null' }); await tick();
  assert.deepEqual(sent, ['@null later'], 'a failed reply holds the next message');
});

test('the room going idle frees every bot, and a reload matches who the machine says is working', async () => {
  const sent = [];
  const q = new ParticipantQueues(async (t) => bots(t), async (text) => { sent.push(text); }, async () => {}, () => {});
  queueHears(q, { type: 'turn_started', id: 'null' });
  await q.send('@null one');
  queueHears(q, { type: 'idle' }); await tick();
  assert.deepEqual(sent, ['@null one']);
  queueSync(q, ['null']);
  await q.send('@null two');
  assert.deepEqual(sent, ['@null one']);
  queueSync(q, []); await tick();
  assert.deepEqual(sent, ['@null one', '@null two']);
});

test('a dropped machine holds the queue and nothing new is queued while it is away', async () => {
  let online = true; const sent = [];
  const q = new ParticipantQueues(async (t) => bots(t), async (text) => { sent.push(text); }, async () => {}, () => {}, () => {}, () => online);
  queueHears(q, { type: 'turn_started', id: 'null' });
  await q.send('@null waits');
  online = false; q.availabilityChanged();
  assert.equal(queuedViews(q.items, ['null'], [], q.connectionPaused, (id) => names[id], 'Test Mac')[0].line, 'Waiting for Test Mac');
  assert.equal(queuedViews(q.items, ['null'], [], q.connectionPaused, (id) => names[id], 'Test Mac')[0].steerable, false);
  await assert.rejects(q.send('@null new'), /nothing was queued/);
  online = true; queueSync(q, []); await tick();
  assert.deepEqual(sent, [], 'waits for Resume after a drop');
  q.resume(); await tick();
  assert.deepEqual(sent, ['@null waits']);
});

test('a message that could not be sent goes back in the box, ahead of newer typing', () => {
  const a = { name: 'a.png' }, b = { name: 'b.png' };
  assert.deepEqual(giveBack({ text: '', files: [] }, { text: 'hi', files: [a] }), { text: 'hi', files: [a] });
  assert.deepEqual(giveBack({ text: 'newer', files: [b] }, { text: 'hi', files: [a] }), { text: 'hi\nnewer', files: [a, b] });
});

test('an untagged message behind a queued tag goes where that tag goes', async () => {
  const { queuedSticky } = await import('../src/phoneQueue.ts');
  const ids = ['null', 'jigga'];
  const queued = [{ id: 1, text: '@null look', kind: 'message', to: ['null'] }];
  assert.deepEqual(queuedSticky('and this', ids, 'mention', queued), ['null']);
  assert.equal(queuedSticky('@jigga and this', ids, 'mention', queued), null, 'a tag in the text wins');
  assert.equal(queuedSticky('@everyone and this', ids, 'mention', queued), null);
  assert.equal(queuedSticky('and this', ids, 'everyone', queued), null, 'only the last-tagged policy follows tags');
  assert.equal(queuedSticky('and this', ids, 'mention', []), null, 'nothing queued: the thread knows');
  assert.equal(queuedSticky('and this', ['jigga'], 'mention', queued), null, 'a bot that left the thread');
});

test('a queued TL;DR message shows as typed, without the hidden TL;DR line', async () => {
  const { withTldr } = await import('../src/tldr.ts');
  const q = new ParticipantQueues(async (t) => bots(t), async () => {}, async () => {}, () => {});
  q.started('null');
  await q.send(withTldr('How far along is the build?', true));
  const [view] = queuedViews(q.items, ['null'], [...q.paused], q.connectionPaused, (id) => names[id], 'Test Mac');
  assert.equal(view.text, 'How far along is the build?');
});
