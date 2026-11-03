import test from 'node:test';
import assert from 'node:assert/strict';
import { planView, newestRun } from '../src/planRunModel.ts';

const run = (state, states = ['open', 'open', 'open', 'open', 'open'], extra = {}) => ({
  request: 'r', by: 'b', detail: '', version: 1, state, reporting: true, started_seq: 0,
  steps: states.map((s, i) => ({ id: `s${i}`, text: `Step ${i}`, state: s, off_plan: false })),
  ...extra,
});

test('nothing unticked starts the whole plan', () => {
  const v = planView(run('waiting'), new Set());
  assert.equal(v.startLabel, 'Start the work');
  assert.equal(v.canStart, true);
  assert.equal(v.note, null);
});

test('some unticked shows the count', () => {
  const v = planView(run('waiting'), new Set(['s0']));
  assert.equal(v.startLabel, 'Start 4 of 5 steps');
  assert.equal(v.canStart, true);
});

test('all unticked cannot start', () => {
  const v = planView(run('waiting'), new Set(['s0', 's1', 's2', 's3', 's4']));
  assert.equal(v.canStart, false);
  assert.equal(v.note, 'Tick at least one step');
});

test('chip line counts done steps and skipped steps leave the total', () => {
  const v = planView(run('running', ['done', 'done', 'active', 'open', 'skipped']), new Set());
  assert.equal(v.done, 2);
  assert.equal(v.total, 4);
  assert.equal(v.chipLine, '2 of 4 steps done');
  assert.equal(planView(run('running', ['done', 'done', 'active', 'open', 'open']), new Set()).chipLine, '2 of 5 steps done');
});

test('stopped run says where it stopped', () => {
  const v = planView(run('stopped', ['done', 'done', 'cancelled', 'cancelled']), new Set());
  assert.equal(v.note, 'Stopped at 2 of 4');
  assert.equal(v.label, 'Stopped');
  assert.equal(v.canStart, false);
});

test('running without reporting is called out', () => {
  assert.equal(planView(run('running', undefined, { reporting: false }), new Set()).note, "This bot isn't reporting steps");
  assert.equal(planView(run('running'), new Set()).note, null);
});

test('each state has its label', () => {
  const label = (s) => planView(run(s), new Set()).label;
  assert.equal(label('waiting'), 'Needs your decision');
  assert.equal(label('running'), 'In progress');
  assert.equal(label('revising'), 'Revising');
  assert.equal(label('done'), 'Done');
  assert.equal(label('stopped'), 'Stopped');
  assert.equal(label('expired'), 'No longer waiting');
  assert.equal(planView(run('expired'), new Set()).canStart, false);
  assert.equal(planView(run('expired'), new Set()).note, 'This plan was never answered');
});

test('newestRun picks the last run', () => {
  assert.equal(newestRun([]), null);
  const a = run('done'); const b = run('waiting');
  assert.equal(newestRun([a, b]), b);
});
