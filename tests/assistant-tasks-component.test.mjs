import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'sucrase';
import * as model from '../src/assistantTaskModel.ts';

const source = await fs.readFile(new URL('../src/ApexAgentTasks.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace('export function ApexAgentTasks', 'function ApexAgentTasks'), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const owner = { workspaceId: 'project', cwd: '/work/project', hostId: 'host-a', conversationId: 'monitor-a' };
const task = (overrides = {}) => ({
  id: 'task-1', workspaceId: owner.workspaceId, owner, destination: { threadId: 'thread-a', workers: ['claude'], newThread: false },
  origin: 'human_request', originalRequest: 'Fix parser', brief: 'Repair the parser and keep tests passing.', evidence: [], reviewCriteria: ['Tests pass'],
  parentThreadId: 'monitor-thread', executionThreadId: 'thread-a', workers: ['claude'], attempts: [], status: 'ready_for_review',
  result: 'Parser repaired.', resultData: { reviewDiff: 'diff --git a/parser.ts', checks: [['npm', 'test']] }, revision: 4,
  mode: 'in_place', usage: null, createdAtMs: 1, updatedAtMs: 2, ...overrides,
});
const snapshot = (tasks = [], executions = []) => ({ workspaceId: owner.workspaceId, revision: 1, tasks, executions });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const find = (node, predicate) => { if (!node || typeof node !== 'object') return null; if (Array.isArray(node)) { for (const child of node) { const found = find(child, predicate); if (found) return found; } return null; } if (predicate(node)) return node; for (const child of node.children ?? []) { const found = find(child, predicate); if (found) return found; } return null; };
const textOf = node => { if (node == null || typeof node === 'boolean') return ''; if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(textOf).join(' '); return textOf(node.children ?? []); };
const findAll = (node, predicate, out = []) => { if (!node || typeof node !== 'object') return out; if (Array.isArray(node)) { node.forEach(item => findAll(item, predicate, out)); return out; } if (predicate(node)) out.push(node); (node.children ?? []).forEach(item => findAll(item, predicate, out)); return out; };
const containsNode = (node, target) => node === target || !!(node && typeof node === 'object' && (Array.isArray(node) ? node.some(child => containsNode(child, target)) : (node.children ?? []).some(child => containsNode(child, target))));
const openDetail = (tree, id = 'task-1') => find(tree, node => node.type === 'button' && node.props.className === 'assistant-task-overview-row' && textOf(node).includes(id) || node.type === 'button' && node.props.className === 'assistant-task-overview-row')?.props.onClick();
const openAdvanced = tree => find(tree, node => node.type === 'button' && node.children[0] === 'Advanced options')?.props.onClick();
function harness(backend, initial = {}, saved = new Map()) {
  const states = [], refs = [], effects = [], observers = []; let cursor = 0, mounted = true, props;
  const previousObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class { constructor(callback, options) { this.callback = callback; this.options = options; observers.push(this); } observe(target) { this.target = target; } disconnect() { this.disconnected = true; } trigger(visible = true) { this.callback([{ target: this.target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }]); } };
  const React = { createElement: (type, props, ...children) => { const node = { type, props: props ?? {}, children: children.flat(Infinity) }; if (node.props.ref) node.props.ref.current = node; return node; } };
  const hooks = {
    useState(value) { const index = cursor++; if (!(index in states)) states[index] = typeof value === 'function' ? value() : value; return [states[index], update => { if (mounted) states[index] = typeof update === 'function' ? update(states[index]) : update; }]; },
    useRef(value) { const index = cursor++; return refs[index] ??= { current: value }; },
    useMemo(fn) { cursor++; return fn(); },
    useEffect(fn, deps) { const index = cursor++, old = effects[index]; if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps[i]))) effects[index] = { fn, deps, changed: true }; },
  };
  const component = new Function('React', ...Object.keys(hooks), ...Object.keys(model), 'window', `${compiled}; return ApexAgentTasks;`)(React, ...Object.values(hooks), ...Object.values(model), { crypto: { randomUUID: () => 'request-fixed' }, localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) } });
  props = { backend, owner, panes: [{ id: 'thread-a', title: 'Build room', kind: 'chat', workspaceId: owner.workspaceId }], profiles: [{ id: 'claude', display_name: 'Claude', backend: { kind: 'agent', tool: 'claude_code' }, media: null }], ...initial };
  const render = () => { cursor = 0; const tree = component(props); for (const effect of effects) if (effect?.changed) { effect.changed = false; effect.cleanup?.(); effect.cleanup = effect.fn(); } return tree; };
  return { render, storage: saved, setReviewVisible(visible = true) { observers.at(-1)?.trigger(visible); }, setProps(next) { props = { ...props, ...next }; }, unmount() { mounted = false; effects.forEach(effect => effect?.cleanup?.()); if (previousObserver) globalThis.IntersectionObserver = previousObserver; else delete globalThis.IntersectionObserver; } };
}

test('overview opens a detail with source request, brief, revision, unknown usage, checks and thread links', async () => {
  const orderedTask = task({ resultData: { ...task().resultData, taskHistory: [] } });
  const backend = { demo: false, call: async command => command === 'assistant_tasks_list' ? snapshot([orderedTask]) : null };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render();
  openDetail(tree); tree = h.render();
  const text = findAll(tree, node => node.type === 'article').map(node => textOf(node.children)).join(' ');
  assert.match(text, /Fix parser/); assert.match(text, /Repair the parser/); assert.match(text, /Revision\s+4/); assert.match(text, /Usage: Unknown/);
  assert.ok(find(tree, node => node.type === 'h3' && node.children[0] === 'Review diff'));
  assert.ok(find(tree, node => node.type === 'summary' && node.children[0] === 'Configured checks and results'));
  const detailScroll = find(tree, node => node.props.className === 'assistant-task-detail-scroll');
  const resultIndex = detailScroll.children.findIndex(node => node?.props?.className === 'assistant-review-material');
  const historyIndex = detailScroll.children.findIndex(node => node?.type === 'details' && textOf(node.children?.[0]) === 'Task history');
  const budgetIndex = detailScroll.children.findIndex(node => node?.props?.className === 'assistant-task-budget');
  assert.ok(resultIndex >= 0 && resultIndex < historyIndex && resultIndex < budgetIndex, 'current review material is prioritized before history and spend controls');
  assert.ok(find(tree, node => node.type === 'button' && node.children[0] === 'Accept and mark done'));
  h.unmount();
});

test('Needs you sits above the transcript, counts review-ready work, and shows at most three rows', async () => {
  const tasks = [task({ status: 'ready_for_review' }), ...['needs_you', 'proposed', 'needs_clarification', 'failed', 'interrupted'].map((status, index) => task({ id: `task-${index + 2}`, status }))];
  const h = harness({ demo: false, call: async command => command === 'assistant_tasks_list' ? snapshot(tasks) : null }, { view: 'chat' });
  let tree = h.render(); await tick(); tree = h.render();
  const needs = find(tree, node => node.props.className === 'assistant-needs-you');
  const transcript = find(tree, node => node.props.className === 'assistant-chat-transcript');
  const composer = find(tree, node => node.type === 'form' && node.props.className === 'assistant-request');
  assert.ok(tree.children.indexOf(needs) < tree.children.indexOf(transcript));
  assert.ok(find(needs, node => node.type === 'button' && /View all.*6/.test(textOf(node))));
  assert.equal(findAll(needs, node => node.props.className === 'assistant-queue-row').length, 3);
  assert.equal(findAll(tree, node => node.type === 'form' && node.props.className === 'assistant-request').at(-1), composer);
  h.unmount();
});

test('task overview groups review, retry, and recovery work under Needs you and settled tasks under Done and stopped', async () => {
  const tasks = [task({ status: 'ready_for_review' }), task({ id: 'failed-task', status: 'failed' }), task({ id: 'interrupted-task', status: 'interrupted' }), task({ id: 'done-task', status: 'done' }), task({ id: 'stopped-task', status: 'cancelled' })];
  const h = harness({ demo: false, call: async command => command === 'assistant_tasks_list' ? snapshot(tasks) : null });
  let tree = h.render(); await tick(); tree = h.render();
  const groups = findAll(tree, node => node.props.className === 'assistant-task-group');
  assert.equal(groups[0].children[0].children[0], 'Needs you');
  assert.equal(groups[0].children[0].children[1].children[0], 3);
  assert.equal(groups[2].children[0].children[0], 'Done and stopped');
  assert.equal(groups[2].children[0].children[1].children[0], 2);
  assert.equal(find(tree, node => node.type === 'h3' && node.children[0] === 'Ready for review'), null);
  h.unmount();
});

test('task draft and selected context survive Activity and Settings view changes', async () => {
  const h = harness({ demo: false, call: async command => command === 'assistant_tasks_list' ? snapshot([task({ status: 'running' })]) : null });
  let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Task context message').props.onChange({ target: { value: 'Keep me across tabs.' } });
  h.setProps({ view: 'activity', children: { type: 'aside', props: {}, children: ['activity child'] } }); tree = h.render();
  assert.match(textOf(tree), /activity child/);
  h.setProps({ view: 'settings', children: { type: 'aside', props: {}, children: ['settings child'] } }); tree = h.render();
  assert.match(textOf(tree), /settings child/);
  h.setProps({ view: 'tasks' }); tree = h.render();
  assert.equal(find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Task context message').props.value, 'Keep me across tabs.');
  assert.match(textOf(tree), /Task note/);
  h.unmount();
});

test('proposed approval uses snapshot-eligible existing worker IDs and disables empty routing', async () => {
  const proposed = task({ status: 'proposed', destination: null, workers: [] }); const actions = [];
  const savedWorker = { id: 'gronk-saved', display_name: 'Gronk Saved', backend: { kind: 'agent', tool: 'claude_code' }, media: null };
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return { ...snapshot([proposed]), routingThreads: [{ id: 'thread-a', workers: [savedWorker] }] }; if (command === 'assistant_task_action') { actions.push(args); return task({ status: 'queued' }); } } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  const approve = find(tree, node => node.type === 'button' && node.children[0] === 'Approve task');
  assert.equal(approve.props.disabled, true);
  find(tree, node => node.type === 'select' && node.props['aria-label'] === 'Destination for task-1').props.onChange({ target: { value: 'thread-a' } }); tree = h.render();
  const worker = find(tree, node => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked === false); worker.props.onChange({ target: { checked: true } }); tree = h.render();
  assert.equal(find(tree, node => node.type === 'button' && node.children[0] === 'Approve task').props.disabled, false);
  await find(tree, node => node.type === 'button' && node.children[0] === 'Approve task').props.onClick(); await tick();
  assert.deepEqual(actions[0].destination.workers, ['gronk-saved']); h.unmount();
});

test('accept is available only in detail and requires current revision acknowledgement and review criteria', async () => {
  const calls = [];
  const backend = { demo: false, call: async (command, args) => { calls.push([command, args]); if (command === 'assistant_tasks_list') return snapshot([task()]); if (command === 'assistant_task_action') return task({ status: 'done', revision: 5 }); } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render();
  assert.equal(find(tree, node => node.type === 'button' && /Accept and mark done|Accept changes/.test(String(node.children[0]))), null);
  openDetail(tree); tree = h.render();
  const ackBeforeView = find(tree, node => node.type === 'label' && node.props.className === 'assistant-review-ack').children.find(node => node.type === 'input');
  assert.equal(ackBeforeView.props.disabled, true, 'acknowledgement stays disabled until the current review result intersects the detail scroll');
  h.setReviewVisible(); tree = h.render();
  find(tree, node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); tree = h.render();
  find(tree, node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); tree = h.render();
  find(tree, node => node.type === 'button' && node.children[0] === 'Accept and mark done').props.onClick(); await tick();
  const action = calls.find(([command]) => command === 'assistant_task_action');
  assert.equal(action[1].taskId, 'task-1'); assert.equal(action[1].revision, 4); assert.deepEqual(action[1].owner, owner); assert.equal(action[1].action, 'accept');
  assert.equal('checks' in action[1], false);
  h.unmount();
});

test('a new task revision invalidates the prior review acknowledgement', async () => {
  const revised = task({ revision: 5, brief: 'Updated after requested changes.' }); let actionDone = false;
  const backend = { demo: false, call: async (command) => { if (command === 'assistant_tasks_list') return snapshot([actionDone ? revised : task()]); if (command === 'assistant_task_action') { actionDone = true; return revised; } return null; } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render(); h.setReviewVisible(); tree = h.render();
  let checks = findAll(tree, node => node.type === 'input' && node.props.type === 'checkbox');
  checks[0].props.onChange({ target: { checked: true } }); tree = h.render();
  checks = findAll(tree, node => node.type === 'input' && node.props.type === 'checkbox');
  checks[1].props.onChange({ target: { checked: true } }); tree = h.render();
  const changeArea = find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Task context message');
  changeArea.props.onChange({ target: { value: 'Update the output format.' } }); tree = h.render();
  await find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} }); await tick(); tree = h.render();
  const accept = find(tree, node => node.type === 'button' && node.children[0] === 'Accept and mark done');
  assert.match(textOf(tree), /Revision\s+5/); assert.equal(accept.props.disabled, true);
  h.unmount();
});

test('captured empty diff is reviewed as a no-change result and read-only result can be marked reviewed', async () => {
  const noChange = task({ result: 'The requested change was already present.', resultData: { reviewDiff: '' } });
  const calls = [];
  let current = noChange;
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([current]); if (command === 'assistant_task_action') { calls.push(args); current = task({ status: 'done', revision: 5, result: noChange.result, resultData: { reviewDiff: '' } }); return current; } } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  assert.match(textOf(tree), /No file changes in this result/);
  assert.equal(find(tree, node => node.type === 'label' && node.props.className === 'assistant-review-ack').children.find(node => node.type === 'input').props.disabled, true);
  h.setReviewVisible(); tree = h.render();
  let checks = findAll(tree, node => node.type === 'input' && node.props.type === 'checkbox');
  checks[0].props.onChange({ target: { checked: true } }); tree = h.render();
  checks = findAll(tree, node => node.type === 'input' && node.props.type === 'checkbox'); checks[1].props.onChange({ target: { checked: true } }); tree = h.render();
  await find(tree, node => node.type === 'button' && node.children[0] === 'Accept and mark done').props.onClick(); await tick();
  assert.equal(calls[0].action, 'accept'); h.unmount();

  const reviewOnly = task({ mode: 'read_only', result: 'Reviewed source and found no action needed.', reviewCriteria: [], resultData: {} });
  const readCalls = [];
  const readBackend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([reviewOnly]); if (command === 'assistant_task_action') { readCalls.push(args); return task({ mode: 'read_only', status: 'done', revision: 5, reviewCriteria: [] }); } } };
  const read = harness(readBackend); tree = read.render(); await tick(); tree = read.render(); openDetail(tree); tree = read.render();
  read.setReviewVisible(); tree = read.render();
  const ack = find(tree, node => node.type === 'input' && node.props.type === 'checkbox'); ack.props.onChange({ target: { checked: true } }); tree = read.render();
  await find(tree, node => node.type === 'button' && node.children[0] === 'Mark reviewed').props.onClick(); await tick();
  assert.equal(readCalls[0].action, 'review'); read.unmount();
});

test('task-context composer adds a note to the selected task and New message exits context', async () => {
  const calls = [];
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([task({ status: 'running' })]); if (command === 'assistant_task_action') { calls.push([command, args]); return task({ status: 'running', revision: 5 }); } } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Task context message').props.onChange({ target: { value: 'Please also include the failing fixture.' } }); tree = h.render();
  await find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} }); await tick();
  assert.equal(calls[0][1].action, 'note'); assert.equal(calls[0][1].text, 'Please also include the failing fixture.');
  assert.equal(calls.some(([command]) => command === 'assistant_message'), false);
  h.unmount();
});

test('back to All tasks preserves task routing and only New message exits the draft context', async () => {
  const calls = [];
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([task({ status: 'running' })]); if (command === 'assistant_task_action') { calls.push(args); return task({ status: 'running', revision: 5 }); } if (command === 'assistant_message') throw new Error('must not reroute task text'); } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  const box = find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Task context message'); box.props.onChange({ target: { value: 'Keep this on task-1.' } }); tree = h.render();
  find(tree, node => node.type === 'button' && node.children[0] === '← All tasks').props.onClick(); tree = h.render();
  assert.equal(find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Task context message').props.value, 'Keep this on task-1.');
  await find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} }); await tick();
  assert.equal(calls[0].action, 'note'); assert.equal(calls[0].text, 'Keep this on task-1.'); h.unmount();
});

test('New message explicitly switches route while keeping the task draft recoverable', async () => {
  const messages = [];
  const monitor = { workspaceId: owner.workspaceId, cwd: owner.cwd, hostId: owner.hostId, conversationId: owner.conversationId };
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([task({ status: 'running' })]); if (command === 'assistant_message') { messages.push(args); return { message: 'Sent as a new message.', monitor }; } } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Task context message').props.onChange({ target: { value: 'Keep for task-1.' } }); tree = h.render();
  find(tree, node => node.type === 'button' && node.children[0] === 'New message').props.onClick(); tree = h.render();
  assert.equal(find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Message for ApexAgent').props.value, '');
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Message for ApexAgent').props.onChange({ target: { value: 'Ask a separate question.' } }); tree = h.render();
  await find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} }); await tick();
  assert.equal(messages[0].text, 'Ask a separate question.'); tree = h.render(); openDetail(tree); tree = h.render();
  assert.equal(find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Task context message').props.value, 'Keep for task-1.'); h.unmount();
});

test('task composer keeps draft after caught backend failure and clears only after success', async () => {
  let fail = true; const calls = [];
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([task({ status: 'running' })]); if (command === 'assistant_task_action') { calls.push(args); if (fail) throw new Error('offline'); return task({ status: 'running', revision: 5 }); } } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Task context message').props.onChange({ target: { value: 'Continue with this note.' } }); tree = h.render();
  await find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} }); await tick(); tree = h.render();
  assert.equal(find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Task context message').props.value, 'Continue with this note.'); assert.match(textOf(tree), /offline/);
  fail = false; await find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} }); await tick(); tree = h.render();
  assert.equal(calls.length, 2); assert.equal(find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Task context message').props.value, ''); h.unmount();
});

test('review context sends request_changes and one actual pending question sends a direct answer', async () => {
  const calls = [], answers = [];
  const waiting = task({ status: 'needs_you', resultData: { pendingQuestions: [{ request: 'q-1', questions: [{ header: 'Target', question: 'Which target?', options: [], multi_select: false }] }] } });
  let current = task({ status: 'ready_for_review' });
  const backend = { demo: false, roomAnswer: async (...args) => answers.push(args), call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([current]); if (command === 'assistant_task_action') { calls.push(args); current = task({ ...current, revision: 5 }); return current; } } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  assert.equal(find(tree, node => node.type === 'button' && node.props.className === 'primary').children[0], 'Request changes');
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Task context message').props.onChange({ target: { value: 'Please adjust the output.' } }); tree = h.render();
  await find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} }); await tick();
  assert.equal(calls[0].action, 'request_changes'); assert.equal(calls[0].text, 'Please adjust the output.');
  h.unmount();
  const questionBackend = { demo: false, roomAnswer: async (...args) => answers.push(args), call: async command => command === 'assistant_tasks_list' ? snapshot([waiting]) : null };
  const questionHarness = harness(questionBackend); tree = questionHarness.render(); await tick(); tree = questionHarness.render(); openDetail(tree); tree = questionHarness.render();
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Task context message').props.onChange({ target: { value: 'Use the parser target.' } }); tree = questionHarness.render();
  await find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} }); await tick();
  assert.deepEqual(answers[0], ['thread-a', 'q-1', [['Use the parser target.']]]); questionHarness.unmount();
});

test('multi-question composer guides inline answers and preserves its text', async () => {
  const waiting = task({ status: 'needs_you', resultData: { pendingQuestions: [{ request: 'q-1', questions: [{ header: 'One', question: 'One?', options: [], multi_select: false }, { header: 'Two', question: 'Two?', options: [], multi_select: false }] }] } });
  const backend = { demo: false, call: async command => command === 'assistant_tasks_list' ? snapshot([waiting]) : null };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Task context message').props.onChange({ target: { value: 'Do not lose this.' } }); tree = h.render();
  assert.equal(find(tree, node => node.type === 'button' && node.props.className === 'primary').props.disabled, true);
  await find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} }); tree = h.render();
  assert.equal(find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Task context message').props.value, 'Do not lose this.'); assert.match(textOf(tree), /Complete every question/); h.unmount();
});

test('routing clarification requires explicit eligible destination worker ID', async () => {
  const calls = []; const clarifying = task({ status: 'needs_clarification' });
  const panes = [{ id: 'thread-a', title: 'Build room', kind: 'chat', workspaceId: owner.workspaceId, participants: [{ id: 'claude' }] }];
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([clarifying]); if (command === 'assistant_task_action') { calls.push(args); return task({ status: 'queued', revision: 5 }); } } };
  const h = harness(backend, { panes }); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Task context message').props.onChange({ target: { value: 'Route to the parser worker.' } }); tree = h.render();
  assert.equal(find(tree, node => node.type === 'button' && node.props.className === 'primary').props.disabled, true);
  find(tree, node => node.type === 'select' && node.props['aria-label'] === 'Destination for task-1').props.onChange({ target: { value: 'thread-a' } }); tree = h.render();
  find(tree, node => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked === false).props.onChange({ target: { checked: true } }); tree = h.render();
  await find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} }); await tick();
  assert.deepEqual(calls[0].destination, { threadId: 'thread-a', newThread: false, workers: ['claude'] }); h.unmount();
});

test('multi-question waits preserve every prompt and option when answered inline', async () => {
  const waiting = task({ status: 'needs_you', resultData: { pendingQuestions: [{ request: 'ask-1', questions: [{ header: 'Parser', question: 'Which parser behavior?', options: [{ label: 'strict', description: 'Reject malformed input.' }, { label: 'loose' }], multi_select: true }, { header: 'Default', question: 'What default name should we use?', options: [], multi_select: false }] }] } });
  const answers = [];
  const backend = { demo: false, roomAnswer: async (...args) => answers.push(args), call: async command => command === 'assistant_tasks_list' ? snapshot([waiting]) : null };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  assert.match(textOf(tree), /Which parser behavior/); assert.match(textOf(tree), /What default name/);
  const choices = findAll(tree, node => node.type === 'input' && node.props.type === 'checkbox');
  const typedAnswers = findAll(tree, node => node.type === 'input' && !node.props.type);
  choices[0].props.onChange({ target: { checked: true } }); typedAnswers[1].props.onChange({ target: { value: 'main' } }); tree = h.render();
  find(tree, node => node.type === 'button' && node.children[0] === 'Send answers').props.onClick(); await tick();
  assert.deepEqual(answers[0], ['thread-a', 'ask-1', [['strict'], ['main']]]);
  h.unmount();
});

test('approval metadata uses the worker room decision API and legacy waits fall back to chat', async () => {
  const approval = { request: 'approve-1', action: { kind: 'command', title: 'Run npm test', detail: 'npm test', risky: false } };
  const waiting = task({ status: 'needs_you', resultData: { pendingApprovals: [approval] } });
  const decisions = [];
  const backend = { demo: false, roomDecide: async (...args) => decisions.push(args), call: async command => command === 'assistant_tasks_list' ? snapshot([waiting]) : null };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  assert.match(textOf(tree), /npm test/);
  await find(tree, node => node.type === 'button' && node.children[0] === 'Approve').props.onClick(); await tick();
  assert.deepEqual(decisions[0], ['thread-a', 'approve-1', true, false]);
  h.unmount();
  const legacy = task({ status: 'needs_you', resultData: { pendingQuestions: [{ prompt: 'Legacy question' }] } });
  const fallback = harness({ demo: false, call: async command => command === 'assistant_tasks_list' ? snapshot([legacy]) : null }); tree = fallback.render(); await tick(); tree = fallback.render(); openDetail(tree); tree = fallback.render();
  assert.match(textOf(tree), /older question format|older metadata/i);
  assert.equal(find(tree, node => node.type === 'button' && node.children[0] === 'Send answers'), null);
  assert.ok(find(tree, node => node.type === 'button' && node.children[0] === 'Open worker chat'));
  fallback.unmount();
});

test('question inputs stay in the detail scroll while answer and approval decisions stay pinned', async () => {
  const waiting = task({ status: 'needs_you', resultData: {
    pendingApprovals: [{ request: 'approve-1', action: { kind: 'command', title: 'Run checks', detail: 'npm test' } }],
    pendingQuestions: [{ request: 'ask-1', questions: [{ header: 'Scope', question: 'Which scope?', options: [{ label: 'all' }], multi_select: false }] }],
  } });
  const h = harness({ demo: false, roomDecide: async () => {}, roomAnswer: async () => {}, call: async command => command === 'assistant_tasks_list' ? snapshot([waiting]) : null });
  let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  const scroll = find(tree, node => node.props.className === 'assistant-task-detail-scroll');
  const footer = find(tree, node => node.props.className === 'assistant-task-actions assistant-task-status-actions');
  const questionInput = find(tree, node => node.type === 'fieldset' && node.props.className === 'assistant-inline-question');
  const answer = find(tree, node => node.type === 'button' && node.children[0] === 'Send answers');
  const approve = find(tree, node => node.type === 'button' && node.children[0] === 'Approve');
  assert.ok(containsNode(scroll, questionInput)); assert.ok(!containsNode(footer, questionInput));
  assert.ok(containsNode(footer, answer)); assert.ok(containsNode(footer, approve));
  assert.ok(!containsNode(scroll, answer)); assert.ok(!containsNode(scroll, approve));
  h.unmount();
});

test('old monitor tasks are hidden and malformed current project owners are rejected', async () => {
  const oldTask = task({ owner: { ...owner, conversationId: 'monitor-old' } });
  const backend = { demo: false, call: async command => command === 'assistant_tasks_list' ? snapshot([oldTask]) : null };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render();
  assert.match(textOf(tree), /No tasks for this assignment yet/); assert.doesNotMatch(textOf(tree), /Fix parser/);
  h.unmount();
  const wrongHost = task({ owner: { ...owner, hostId: 'wrong-host' } });
  const bad = harness({ demo: false, call: async () => snapshot([wrongHost]) }); tree = bad.render(); await tick(); tree = bad.render();
  assert.match(textOf(tree), /different project folder or machine/); assert.doesNotMatch(textOf(tree), /Fix parser/);
  bad.unmount();
});

test('uncertain assistant requests retry with the same id, original text and chosen destination', async () => {
  const calls = []; let attempts = 0;
  const returnedMonitor = { workspaceId: owner.workspaceId, hostId: owner.hostId, cwd: owner.cwd, conversationId: owner.conversationId };
  const backend = { demo: false, call: async (command, args) => {
    if (command === 'assistant_tasks_list') return snapshot([]);
    if (command === 'assistant_message') { calls.push(args); if (!attempts++) throw new Error('connection lost'); return { message: 'Saved', monitor: returnedMonitor }; }
  } };
  const h = harness(backend, { view: 'chat', onMonitorUpdate() {} }); let tree = h.render(); await tick(); tree = h.render();
  openAdvanced(tree); tree = h.render(); find(tree, node => node.type === 'select' && node.props['aria-label'] === 'Task destination').props.onChange({ target: { value: 'thread-a' } });
  tree = h.render(); find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Message for ApexAgent').props.onChange({ target: { value: 'Please repair the parser.' } }); tree = h.render();
  await find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} });
  tree = h.render(); assert.match(textOf(tree), /Retry uses the saved request ID/);
  const renamedPanes = [{ id: 'thread-a', title: 'Renamed or archived chat', kind: 'chat', workspaceId: owner.workspaceId, archived: true }];
  h.setProps({ panes: renamedPanes }); tree = h.render();
  const recoveredHarness = harness(backend, { view: 'chat', onMonitorUpdate() {}, panes: renamedPanes }, h.storage); let recoveredTree = recoveredHarness.render(); await tick(); recoveredTree = recoveredHarness.render();
  assert.match(textOf(recoveredTree), /Retry uses the saved request ID/);
  assert.equal(find(recoveredTree, node => node.type === 'textarea' && node.props['aria-label'] === 'Message for ApexAgent').props.value, 'Please repair the parser.');
  await find(recoveredTree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} });
  assert.equal(calls.length, 2); assert.equal(calls[0].requestId, calls[1].requestId); assert.deepEqual(calls[0].threadLabels, [{ id: 'thread-a', label: 'Build room' }]); assert.deepEqual(calls[1].threadLabels, calls[0].threadLabels);
  recoveredTree = recoveredHarness.render(); assert.match(textOf(recoveredTree), /Saved/);
  recoveredHarness.unmount();
  assert.ok(calls[0].requestId);
  assert.equal(calls[0].text, 'Please repair the parser.'); assert.deepEqual(calls[0].destination, calls[1].destination);
  assert.equal(calls[0].destination.threadId, 'thread-a'); assert.deepEqual(calls[0].destination.workers, []); assert.equal(calls[0].mode, 'in_place');
  h.unmount();
});

test('ordinary conversation uses natural routing and isolated mode is retained in the durable payload', async () => {
  const calls = [];
  const returnedMonitor = { workspaceId: owner.workspaceId, hostId: owner.hostId, cwd: owner.cwd, conversationId: owner.conversationId };
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([]); if (command === 'assistant_message') { calls.push(args); return { message: 'Routed', monitor: returnedMonitor }; } } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render();
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Message for ApexAgent').props.onChange({ target: { value: 'Find the right place for this.' } });
  openAdvanced(tree); tree = h.render(); find(tree, node => node.type === 'select' && node.props['aria-label'] === 'Execution mode').props.onChange({ target: { value: 'isolated' } }); tree = h.render();
  await find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} });
  assert.equal(calls[0].destination, null); assert.equal(calls[0].mode, 'isolated'); assert.deepEqual(calls[0].checks, []);
  h.unmount();
});

test('new destination starts without an implicit worker and requires an explicit worker choice', async () => {
  const calls = [];
  const returnedMonitor = { workspaceId: owner.workspaceId, hostId: owner.hostId, cwd: owner.cwd, conversationId: owner.conversationId };
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([]); if (command === 'assistant_message') { calls.push(args); return { message: 'Queued', monitor: returnedMonitor }; } } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openAdvanced(tree); tree = h.render();
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Message for ApexAgent').props.onChange({ target: { value: 'Start a worker.' } });
  tree = h.render(); find(tree, node => node.type === 'select' && node.props['aria-label'] === 'Task destination').props.onChange({ target: { value: 'new' } }); tree = h.render();
  const send = () => find(tree, node => node.type === 'button' && node.props.className === 'primary');
  assert.equal(send().props.disabled, true);
  find(tree, node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); tree = h.render();
  assert.equal(send().props.disabled, false);
  await find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(calls[0].destination.workers, ['claude']); assert.deepEqual(calls[0].newWorkerProfiles.map(profile => profile.id), ['claude']);
  h.unmount();
});

test('isolated terminal task can be archived while preserving result and history', async () => {
  const terminal = task({ status: 'done', mode: 'isolated', resultData: { reviewDiff: 'reviewed' } });
  const archived = task({ status: 'done', mode: 'isolated', revision: 5, resultData: { reviewDiff: 'reviewed', archivedAtMs: 123, worktreeDiskBytes: 2048 } });
  const calls = []; let didArchive = false;
  const backend = { demo: false, call: async (command, args) => {
    if (command === 'assistant_tasks_list') return didArchive ? snapshot([archived], [{ taskId: terminal.id, tombstonedAtMs: 123 }]) : snapshot([terminal], [{ taskId: terminal.id, tombstonedAtMs: null }]);
    if (command === 'assistant_task_action') { calls.push(args); didArchive = true; return archived; }
  } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  assert.match(textOf(tree), /Archive isolated worktree/);
  find(tree, node => node.type === 'button' && node.children[0] === 'Archive isolated worktree').props.onClick(); await tick(); tree = h.render(); await tick(); tree = h.render();
  assert.equal(calls[0].action, 'archive'); assert.equal(calls[0].taskId, terminal.id); assert.equal(calls[0].revision, terminal.revision);
  assert.match(textOf(tree), /worktree archived.*saved worktree size 2 KB/); assert.match(textOf(tree), /Task result and history are retained/);
  assert.equal(find(tree, node => node.type === 'button' && node.children[0] === 'Archive isolated worktree'), null);
  h.unmount();
});

test('interrupted isolated integration exposes explicit reconciliation only with saved journal metadata', async () => {
  const interrupted = task({ status: 'interrupted', mode: 'isolated', resultData: { integrationPlan: { target: 'main' }, applyJournal: '/data/journal.json' } });
  const calls = [];
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([interrupted]); if (command === 'assistant_task_action') { calls.push(args); return task({ status: 'ready_for_review', revision: 5 }); } } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  find(tree, node => node.type === 'button' && node.children[0] === 'Recover interrupted integration').props.onClick(); await tick();
  assert.equal(calls[0].action, 'reconcile'); assert.equal(calls[0].revision, interrupted.revision);
  h.unmount();
});

test('isolated NeedsYou startup failure can be retried without pretending the worker asked a question', async () => {
  const startup = task({ status: 'needs_you', mode: 'isolated', attempts: [], resultData: { startup: { message: 'Worker failed before starting.' } } });
  const calls = [];
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([startup]); if (command === 'assistant_task_action') { calls.push(args); return task({ status: 'running', revision: 5, mode: 'isolated' }); } } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  assert.match(textOf(tree), /Worker failed before starting/);
  find(tree, node => node.type === 'button' && node.children[0] === 'Retry worker startup').props.onClick(); await tick();
  assert.equal(calls[0].action, 'retry'); assert.equal(calls[0].revision, startup.revision);
  h.unmount();
});

test('wrong-owner task in a successful-looking message reply is rejected and retry state remains', async () => {
  const monitor = { workspaceId: owner.workspaceId, cwd: owner.cwd, hostId: owner.hostId, conversationId: owner.conversationId };
  const backend = { demo: false, call: async command => command === 'assistant_tasks_list' ? snapshot([]) : ({ message: 'Looks done', monitor, task: task({ owner: { ...owner, conversationId: 'other' } }) }) };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render();
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Message for ApexAgent').props.onChange({ target: { value: 'Keep retryable' } }); tree = h.render();
  await find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} }); tree = h.render();
  assert.match(textOf(tree), /task for a different assignment/); assert.match(textOf(tree), /Retry uses the saved request ID/);
  assert.equal(find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Message for ApexAgent').props.value, 'Keep retryable');
  h.unmount();
});

test('reassigning the component clears an in-flight owner busy state and ignores its late response', async () => {
  let finishSend; const ownerB = { workspaceId: 'project-b', cwd: '/work/b', hostId: 'host-b', conversationId: 'monitor-b' };
  const backend = { demo: false, call: async (command) => {
    if (command === 'assistant_tasks_list') return { workspaceId: ownerB.workspaceId, revision: 1, tasks: [], executions: [] };
    if (command === 'assistant_message') return new Promise(resolve => { finishSend = resolve; });
  } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render();
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Message for ApexAgent').props.onChange({ target: { value: 'Old owner request' } }); tree = h.render();
  const oldSend = find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} });
  tree = h.render(); assert.equal(find(tree, node => node.type === 'button' && node.props.className === 'primary').props.disabled, true);
  h.setProps({ owner: ownerB }); tree = h.render();
  assert.equal(find(tree, node => node.type === 'button' && node.props.className === 'primary').props.disabled, true, 'empty new-owner draft remains disabled');
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Message for ApexAgent').props.onChange({ target: { value: 'New owner request' } }); tree = h.render();
  assert.equal(find(tree, node => node.type === 'button' && node.props.className === 'primary').props.disabled, false, 'new owner can send while old call remains unresolved');
  finishSend({ message: 'Old response', monitor: { workspaceId: owner.workspaceId, cwd: owner.cwd, hostId: owner.hostId, conversationId: owner.conversationId } }); await oldSend; tree = h.render();
  assert.doesNotMatch(textOf(tree), /Old response/); assert.equal(find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Message for ApexAgent').props.value, 'New owner request');
  h.unmount();
});
