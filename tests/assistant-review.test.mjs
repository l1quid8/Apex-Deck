import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { assistantTaskActionArgs, taskStatusLabel } from '../src/assistantTaskModel.ts';

const require = createRequire(import.meta.url);
const { transform } = require('sucrase');
const source = fs.readFileSync(new URL('../src/AssistantReview.tsx', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const compiled = transform(source.replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;

const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }) };
const all = (tree) => (tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flatMap(all)] : []);
const text = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(text).join(''));
const byClass = (tree, name) => all(tree).filter((node) => String(node.props?.className ?? '').split(' ').includes(name));

function mount(props = {}) {
  const states = [];
  let cursor = 0;
  const useState = (initial) => {
    const i = cursor++;
    if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
    return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
  };
  const harness = {
    render(extra = {}) {
      cursor = 0;
      const local = new Function(
        'React', 'useState', 'assistantTaskActionArgs', 'taskStatusLabel',
        `${compiled}\nreturn { AssistantReview, reviewFiles, reviewChecks };`,
      )(React, useState, assistantTaskActionArgs, taskStatusLabel);
      return local.AssistantReview({ ...props, ...extra });
    },
    modules: new Function(
      'React', 'useState', 'assistantTaskActionArgs', 'taskStatusLabel',
      `${compiled}\nreturn { AssistantReview, reviewFiles, reviewChecks };`,
    )(React, useState, assistantTaskActionArgs, taskStatusLabel),
  };
  return harness;
}

const DIFF = [
  'diff --git a/docs/notes.md b/docs/notes.md',
  'index 1111111..2222222 100644',
  '--- a/docs/notes.md',
  '+++ b/docs/notes.md',
  '@@ -1,3 +1,3 @@',
  '-old line',
  '+new line',
  '+another line',
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1 +1 @@',
  '-gone',
  '+kept',
].join('\n');

const task = {
  id: 't1', brief: 'Rewrite the release notes', revision: 7, status: 'ready_for_review', mode: 'isolated',
  owner: { workspaceId: 'w', cwd: '/work/app', hostId: 'host', conversationId: 'c' },
  result: 'Drafted a shorter note.',
  resultData: { reviewDiff: DIFF, checkResults: [{ argv: ['npm', 'run', 'check'], success: true }, { argv: ['npm', 'test'], success: false, error: '1 failing test' }] },
  workers: [], reviewCriteria: [], attempts: [], createdAtMs: 0, updatedAtMs: 1000,
};

const backendFor = (calls, returned = task) => ({ call: async (name, args) => { calls.push([name, args]); return returned; } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('files changed carries one row per file with its line counts', () => {
  const { reviewFiles } = mount().modules;
  assert.deepEqual(reviewFiles(DIFF), [
    { path: 'docs/notes.md', added: 2, removed: 1 },
    { path: 'src/app.ts', added: 1, removed: 1 },
  ]);
  assert.deepEqual(reviewFiles(''), [], 'no patch means no rows');
  assert.deepEqual(reviewFiles(undefined), []);
});

test('checks read the recorded argv and outcome, and unusable entries are dropped', () => {
  const { reviewChecks } = mount().modules;
  assert.deepEqual(reviewChecks([{ argv: ['npm', 'run', 'check'], success: true }, { argv: ['npm', 'test'], success: false, error: '1 failing test' }]), [
    { command: 'npm run check', passed: true },
    { command: 'npm test', passed: false, detail: '1 failing test' },
  ]);
  assert.deepEqual(reviewChecks([{ argv: [], success: true }, null, 'nonsense']), []);
  assert.deepEqual(reviewChecks(undefined), []);
});

test('the review shows the revision, the files and the checks before anything is accepted', () => {
  const calls = [];
  const tree = mount({ task, name: 'Null', backend: backendFor(calls), onBack: () => {}, onDone: () => {} }).render();
  assert.match(text(byClass(tree, 'assistant-review-title')[0]), /Rewrite the release notes/);
  assert.match(text(byClass(tree, 'assistant-review-meta')[0]), /Null · revision 7 · separate copy/);
  assert.match(text(byClass(tree, 'assistant-review-summary')[0]), /Drafted a shorter note/);
  assert.deepEqual(byClass(tree, 'assistant-review-path').map((node) => node.props.title), ['docs/notes.md', 'src/app.ts']);
  assert.match(text(byClass(tree, 'assistant-review-file')[0]), /\+2 −1/);
  assert.deepEqual(byClass(tree, 'assistant-review-check').map((node) => node.props['data-passed']), ['true', 'false']);
  assert.match(text(byClass(tree, 'assistant-review-accept')[0]), /Accept revision 7/);
  assert.deepEqual(calls, [], 'opening a review sends nothing');
});

test('accepting sends the revision on screen, and a stale answer is refused', async () => {
  const calls = [];
  let done = 0;
  const tree = mount({ task, name: 'Null', backend: backendFor(calls), onBack: () => {}, onDone: () => { done += 1; } }).render();
  byClass(tree, 'assistant-review-accept')[0].props.onClick();
  await settle();
  assert.deepEqual(calls, [['assistant_task_action', assistantTaskActionArgs(task, 'accept', {})]]);
  assert.equal(calls[0][1].revision, 7, 'the action carries the revision the human reviewed');
  assert.equal(done, 1);

  const stale = [];
  const harness = mount({ task, name: 'Null', backend: backendFor(stale, { ...task, id: 'other' }), onBack: () => {}, onDone: () => { done += 1; } });
  const next = harness.render();
  byClass(next, 'assistant-review-accept')[0].props.onClick();
  await settle();
  assert.equal(done, 1, 'a different task never counts as accepted');
  assert.match(text(byClass(harness.render(), 'assistant-review-problem')[0]), /different task/);
});

test('a read-only result is marked reviewed instead of applied', async () => {
  const calls = [];
  const readOnly = { ...task, mode: 'read_only', status: 'ready_for_review', resultData: { checkResults: [{ argv: ['npm', 'run', 'check'], success: true }] } };
  const tree = mount({ task: readOnly, name: 'Null', backend: backendFor(calls, readOnly), onBack: () => {}, onDone: () => {} }).render();
  assert.match(text(byClass(tree, 'assistant-review-accept')[0]), /Mark revision 7 reviewed/);
  assert.match(text(byClass(tree, 'assistant-review-meta')[0]), /read only · nothing to apply/);
  assert.match(text(byClass(tree, 'assistant-review-block')[0]), /No files were written|Read-only task/);
  byClass(tree, 'assistant-review-accept')[0].props.onClick();
  await settle();
  assert.equal(calls[0][1].action, 'review');
});

test('asking for changes needs the note, then sends it as the correction', async () => {
  const calls = [];
  const harness = mount({ task, name: 'Null', backend: backendFor(calls), onBack: () => {}, onDone: () => {} });
  let tree = harness.render();
  assert.equal(byClass(tree, 'assistant-review-ask')[0].props.disabled, true, 'no note means nothing to ask');
  byClass(tree, 'assistant-review-note')[0].children[1].props.onChange({ target: { value: 'Tighten the summary.' } });
  tree = harness.render();
  assert.equal(byClass(tree, 'assistant-review-ask')[0].props.disabled, false);
  byClass(tree, 'assistant-review-ask')[0].props.onClick();
  await settle();
  assert.equal(calls[0][1].action, 'request_changes');
  assert.equal(calls[0][1].text, 'Tighten the summary.');
  assert.equal(calls[0][1].revision, 7);
});

test('a revision that is not ready cannot be accepted, and Back leaves the review', () => {
  let backs = 0;
  const tree = mount({ task: { ...task, status: 'running' }, name: 'Null', backend: backendFor([]), onBack: () => { backs += 1; }, onDone: () => {} }).render();
  assert.equal(byClass(tree, 'assistant-review-accept')[0].props.disabled, true);
  assert.equal(byClass(tree, 'assistant-review-ask')[0].props.disabled, true);
  assert.match(text(tree), /cannot be accepted yet/);
  byClass(tree, 'assistant-details-back')[0].props.onClick();
  assert.equal(backs, 1);
});
