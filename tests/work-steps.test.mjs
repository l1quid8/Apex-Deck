import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberSteps, applyStepEvent, emptyTurnSteps, isUnknownStepsCommand, readReplySteps, readStepsIndex, restoreTurnSteps, savedEntry, stepTree, stepsCountLabel } from '../src/workSteps.ts';

const step = (key, extra = {}) => ({ key, parent: null, kind: 'command', label: key, folder: null, detail: key, output: null, status: 'running', exit_code: null, duration_ms: null, ...extra });
const ev = (s) => ({ type: 'work_step', id: 'null', step: s });

test('upsert keeps one entry per key and keeps output when the done event has none', () => {
  let t = applyStepEvent(emptyTurnSteps, ev(step('a')));
  assert.equal(t.structured, true);
  t = applyStepEvent(t, ev(step('a', { output: 'hi', output_cut: true })));
  t = applyStepEvent(t, ev(step('a', { status: 'done', exit_code: 0 })));
  assert.equal(t.steps.length, 1);
  assert.equal(t.steps[0].output, 'hi');
  assert.equal(t.steps[0].output_cut, true);
  assert.equal(t.steps[0].status, 'done');
});

test('events preserve ordered text and coalesce top-level activity without duplicate references', () => {
  const t = applyStepEvent(emptyTurnSteps, ev(step('a')));
  assert.equal(applyStepEvent(t, ev(step('a'))), t);
  let next = applyStepEvent(t, { type: 'delta', id: 'null', text: 'Reading' });
  next = applyStepEvent(next, { type: 'delta', id: 'null', text: ' files' });
  next = applyStepEvent(next, ev(step('b', { kind: 'read' })));
  next = applyStepEvent(next, ev(step('b', { kind: 'read', status: 'done' })));
  assert.deepEqual(next.timeline, [
    { kind: 'activity', keys: ['a'] },
    { kind: 'text', text: 'Reading files' },
    { kind: 'activity', keys: ['b'] },
  ]);
  const nested = applyStepEvent(next, ev(step('child', { parent: 'helper' })));
  assert.deepEqual(nested.timeline.at(-1), { kind: 'activity', keys: ['b'] });
});

test('todo replaces wholesale and does not flip structured', () => {
  let t = applyStepEvent(emptyTurnSteps, { type: 'todo', id: 'null', items: [{ text: 'a', status: 'pending' }, { text: 'b', status: 'pending' }] });
  t = applyStepEvent(t, { type: 'todo', id: 'null', items: [{ text: 'c', status: 'completed' }] });
  assert.deepEqual(t.todo, [{ text: 'c', status: 'completed' }]);
  assert.equal(t.structured, false);
});

test('tree: unknown parent stays top-level, helper children keep order', () => {
  const tree = stepTree([step('h', { kind: 'helper' }), step('x', { parent: 'h' }), step('o', { parent: 'gone' }), step('y', { parent: 'h' }), step('z')]);
  assert.deepEqual(tree.map((n) => n.step.key), ['h', 'o', 'z']);
  assert.deepEqual(tree[0].children.map((n) => n.step.key), ['x', 'y']);
});

test('count label', () => {
  assert.equal(stepsCountLabel(1), '1 step');
  assert.equal(stepsCountLabel(83), '83 steps');
  assert.equal(stepsCountLabel(0), '0 steps');
});

test('readStepsIndex', () => {
  for (const bad of [null, {}, 'x', [], { version: 1 }, { version: 'a', replies: {} }]) assert.equal(readStepsIndex(bad), null);
  const entry = { by: 'null', count: 3, helpers: 1, offset: 0, len: 40, todo_count: 2, todo_completed: 1 };
  assert.deepEqual(readStepsIndex({ version: 1, replies: { 7: entry, 8: { by: 1 } } }), { version: 1, replies: { 7: entry } });
  assert.equal(savedEntry(readStepsIndex({ version: 1, replies: { 7: { ...entry, count: 0 } } }), 7)?.todo_count, 2);
});

test('readReplySteps drops damaged steps and rejects damaged records', () => {
  assert.equal(readReplySteps(null), null);
  assert.equal(readReplySteps('x'), null);
  assert.equal(readReplySteps({ by: 'null', seq: 1, steps: 'no', todo: [], dropped: 0 }), null);
  const r = readReplySteps({ by: 'null', seq: 4, steps: [step('a'), { key: 'b' }, step('c', { kind: 'weird' })], todo: [{ text: 't', status: 'pending' }, { text: 1 }], dropped: 2 });
  assert.deepEqual(r.steps.map((s) => s.key), ['a']);
  assert.equal(r.todo.length, 1);
  assert.equal(r.dropped, 2);
});

test('saved timelines are validated and can restore a live turn snapshot', () => {
  const reply = readReplySteps({ by: 'bot', seq: 1, steps: [step('a')], todo: [{ text: 'Do it', status: 'pending' }], dropped: 0,
    timeline: [{ kind: 'text', text: 'Hello' }, { kind: 'activity', keys: ['a', 9] }, { kind: 'wat' }] });
  assert.deepEqual(reply.timeline, [{ kind: 'text', text: 'Hello' }]);
  assert.deepEqual(restoreTurnSteps({ by: 'bot', seq: 1, steps: [step('a')], todo: [], dropped: 0 }).steps.map((s) => s.key), ['a']);
  assert.equal(restoreTurnSteps({ broken: true }), emptyTurnSteps);
});

test('old-daemon rejection is recognised', () => {
  assert.equal(isUnknownStepsCommand(new Error('unknown variant `room_steps`, expected one of')), true);
  assert.equal(isUnknownStepsCommand(new Error('disk failure')), false);
});

test('rememberSteps only keeps a reply for the thread that is still open', () => {
  const cache = new Map();
  const reply = { by: 'null', seq: 3, steps: [], todo: [], dropped: 0 };
  rememberSteps(cache, 'b', 'a', 3, reply);
  assert.equal(cache.size, 0);
  rememberSteps(cache, 'a', 'a', 3, null);
  assert.equal(cache.size, 0);
  rememberSteps(cache, 'a', 'a', 3, reply);
  assert.equal(cache.get(3), reply);
});

test('long live commentary is bounded and truncation stays visible', () => {
 let t=applyStepEvent(emptyTurnSteps,{type:'delta',id:'a',text:'x'.repeat(300_000)});
 assert.ok(t.timeline[0].text.length<=256*1024);
 assert.equal(t.timeline_cut,true);
 const last=t.timeline[0].text;
 t=applyStepEvent(t,{type:'delta',id:'a',text:'more'});
 assert.equal(t.timeline[0].text,last);
});
