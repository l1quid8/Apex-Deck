import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStepEvent, emptyTurnSteps, isUnknownStepsCommand, readReplySteps, readStepsIndex, stepTree, stepsCountLabel } from '../src/workSteps.ts';

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

test('same object back when nothing changes or the event is another type', () => {
  const t = applyStepEvent(emptyTurnSteps, ev(step('a')));
  assert.equal(applyStepEvent(t, ev(step('a'))), t);
  assert.equal(applyStepEvent(t, { type: 'delta', id: 'null', text: 'x' }), t);
  assert.equal(applyStepEvent(emptyTurnSteps, { type: 'delta', id: 'null', text: 'x' }), emptyTurnSteps);
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
  const entry = { by: 'null', count: 3, helpers: 1, offset: 0, len: 40 };
  assert.deepEqual(readStepsIndex({ version: 1, replies: { 7: entry, 8: { by: 1 } } }), { version: 1, replies: { 7: entry } });
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

test('old-daemon rejection is recognised', () => {
  assert.equal(isUnknownStepsCommand(new Error('unknown variant `room_steps`, expected one of')), true);
  assert.equal(isUnknownStepsCommand(new Error('disk failure')), false);
});
