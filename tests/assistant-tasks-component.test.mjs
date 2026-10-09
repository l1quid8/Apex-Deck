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
function harness(backend, initial = {}, saved = new Map()) {
  const states = [], refs = [], effects = []; let cursor = 0, mounted = true, props;
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
  const hooks = {
    useState(value) { const index = cursor++; if (!(index in states)) states[index] = typeof value === 'function' ? value() : value; return [states[index], update => { if (mounted) states[index] = typeof update === 'function' ? update(states[index]) : update; }]; },
    useRef(value) { const index = cursor++; return refs[index] ??= { current: value }; },
    useMemo(fn) { cursor++; return fn(); },
    useEffect(fn, deps) { const index = cursor++, old = effects[index]; if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps[i]))) effects[index] = { fn, deps, changed: true }; },
  };
  const component = new Function('React', ...Object.keys(hooks), ...Object.keys(model), 'window', `${compiled}; return ApexAgentTasks;`)(React, ...Object.values(hooks), ...Object.values(model), { crypto: { randomUUID: () => 'request-fixed' }, localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) } });
  props = { backend, owner, panes: [{ id: 'thread-a', title: 'Build room', kind: 'chat', workspaceId: owner.workspaceId }], profiles: [{ id: 'claude', display_name: 'Claude', backend: { kind: 'agent', tool: 'claude_code' }, media: null }], ...initial };
  const render = () => { cursor = 0; const tree = component(props); for (const effect of effects) if (effect?.changed) { effect.changed = false; effect.cleanup?.(); effect.cleanup = effect.fn(); } return tree; };
  return { render, storage: saved, setProps(next) { props = { ...props, ...next }; }, unmount() { mounted = false; effects.forEach(effect => effect?.cleanup?.()); } };
}

test('task cards show the source request, brief, revision, unknown usage, checks and thread links', async () => {
  const backend = { demo: false, call: async command => command === 'assistant_tasks_list' ? snapshot([task()]) : null };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render();
  const text = findAll(tree, node => node.type === 'article').map(node => textOf(node.children)).join(' ');
  assert.match(text, /Fix parser/); assert.match(text, /Repair the parser/); assert.match(text, /Revision\s+4/); assert.match(text, /Usage: Unknown/);
  assert.ok(find(tree, node => node.type === 'summary' && node.children[0] === 'Review diff'));
  assert.ok(find(tree, node => node.type === 'summary' && node.children[0] === 'Configured checks and results'));
  assert.ok(find(tree, node => node.type === 'button' && node.children[0] === 'Accept and mark Done'));
  h.unmount();
});

test('task actions use the task revision and preserve the task owner without turning review prose into commands', async () => {
  const calls = [];
  const backend = { demo: false, call: async (command, args) => { calls.push([command, args]); if (command === 'assistant_tasks_list') return snapshot([task()]); if (command === 'assistant_task_action') return task({ status: 'done', revision: 5 }); } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render();
  find(tree, node => node.type === 'button' && node.children[0] === 'Accept and mark Done').props.onClick(); await tick();
  const action = calls.find(([command]) => command === 'assistant_task_action');
  assert.equal(action[1].taskId, 'task-1'); assert.equal(action[1].revision, 4); assert.deepEqual(action[1].owner, owner); assert.equal(action[1].action, 'accept');
  assert.equal('checks' in action[1], false);
  h.unmount();
});

test('needs-you cards expose actual questions and route the user to the worker thread without answering', async () => {
  const waiting = task({ status: 'needs_you', resultData: { pendingQuestions: [{ prompt: 'Which parser behavior should we keep?' }], pendingApprovals: [{ title: 'Run formatter' }] } });
  let opened;
  const backend = { demo: false, call: async command => command === 'assistant_tasks_list' ? snapshot([waiting]) : null };
  const h = harness(backend, { onOpenThread: id => { opened = id; } }); let tree = h.render(); await tick(); tree = h.render();
  assert.ok(find(tree, node => node.type === 'p' && String(node.children[0]).includes('Which parser behavior')));
  assert.ok(find(tree, node => node.type === 'p' && String(node.children[0]).includes('Run formatter')));
  find(tree, node => node.type === 'button' && node.children[0] === 'Open worker thread to answer').props.onClick();
  assert.equal(opened, 'thread-a');
  assert.equal(find(tree, node => node.type === 'button' && /approve|answer/i.test(String(node.children[0])) && !/Open worker thread/.test(String(node.children[0]))), null);
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
  const h = harness(backend, { onMonitorUpdate() {} }); let tree = h.render(); await tick(); tree = h.render();
  find(tree, node => node.type === 'select' && node.props['aria-label'] === 'Task destination').props.onChange({ target: { value: 'thread-a' } });
  tree = h.render(); find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Original task request').props.onChange({ target: { value: 'Please repair the parser.' } }); tree = h.render();
  await find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} });
  tree = h.render(); assert.match(textOf(tree), /Retry uses the saved request ID/);
  const renamedPanes = [{ id: 'thread-a', title: 'Renamed or archived chat', kind: 'chat', workspaceId: owner.workspaceId, archived: true }];
  h.setProps({ panes: renamedPanes }); tree = h.render();
  const recoveredHarness = harness(backend, { onMonitorUpdate() {}, panes: renamedPanes }, h.storage); let recoveredTree = recoveredHarness.render(); await tick(); recoveredTree = recoveredHarness.render();
  assert.match(textOf(recoveredTree), /Retry uses the saved request ID/);
  assert.equal(find(recoveredTree, node => node.type === 'textarea' && node.props['aria-label'] === 'Original task request').props.value, 'Please repair the parser.');
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
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Original task request').props.onChange({ target: { value: 'Find the right place for this.' } });
  tree = h.render(); find(tree, node => node.type === 'select' && node.props['aria-label'] === 'Execution mode').props.onChange({ target: { value: 'isolated' } }); tree = h.render();
  await find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} });
  assert.equal(calls[0].destination, null); assert.equal(calls[0].mode, 'isolated'); assert.deepEqual(calls[0].checks, []);
  h.unmount();
});

test('new destination starts without an implicit worker and requires an explicit worker choice', async () => {
  const calls = [];
  const returnedMonitor = { workspaceId: owner.workspaceId, hostId: owner.hostId, cwd: owner.cwd, conversationId: owner.conversationId };
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([]); if (command === 'assistant_message') { calls.push(args); return { message: 'Queued', monitor: returnedMonitor }; } } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render();
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Original task request').props.onChange({ target: { value: 'Start a worker.' } });
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
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render();
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
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render();
  find(tree, node => node.type === 'button' && node.children[0] === 'Recover interrupted integration').props.onClick(); await tick();
  assert.equal(calls[0].action, 'reconcile'); assert.equal(calls[0].revision, interrupted.revision);
  h.unmount();
});

test('isolated NeedsYou startup failure can be retried without pretending the worker asked a question', async () => {
  const startup = task({ status: 'needs_you', mode: 'isolated', attempts: [], resultData: { startup: { message: 'Worker failed before starting.' } } });
  const calls = [];
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([startup]); if (command === 'assistant_task_action') { calls.push(args); return task({ status: 'running', revision: 5, mode: 'isolated' }); } } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render();
  assert.match(textOf(tree), /Worker failed before starting/);
  find(tree, node => node.type === 'button' && node.children[0] === 'Retry worker startup').props.onClick(); await tick();
  assert.equal(calls[0].action, 'retry'); assert.equal(calls[0].revision, startup.revision);
  h.unmount();
});

test('wrong-owner task in a successful-looking message reply is rejected and retry state remains', async () => {
  const monitor = { workspaceId: owner.workspaceId, cwd: owner.cwd, hostId: owner.hostId, conversationId: owner.conversationId };
  const backend = { demo: false, call: async command => command === 'assistant_tasks_list' ? snapshot([]) : ({ message: 'Looks done', monitor, task: task({ owner: { ...owner, conversationId: 'other' } }) }) };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render();
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Original task request').props.onChange({ target: { value: 'Keep retryable' } }); tree = h.render();
  await find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} }); tree = h.render();
  assert.match(textOf(tree), /task for a different assignment/); assert.match(textOf(tree), /Retry uses the saved request ID/);
  assert.equal(find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Original task request').props.value, 'Keep retryable');
  h.unmount();
});

test('reassigning the component clears an in-flight owner busy state and ignores its late response', async () => {
  let finishSend; const ownerB = { workspaceId: 'project-b', cwd: '/work/b', hostId: 'host-b', conversationId: 'monitor-b' };
  const backend = { demo: false, call: async (command) => {
    if (command === 'assistant_tasks_list') return { workspaceId: ownerB.workspaceId, revision: 1, tasks: [], executions: [] };
    if (command === 'assistant_message') return new Promise(resolve => { finishSend = resolve; });
  } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render();
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Original task request').props.onChange({ target: { value: 'Old owner request' } }); tree = h.render();
  const oldSend = find(tree, node => node.type === 'form' && node.props.className === 'assistant-request').props.onSubmit({ preventDefault() {} });
  tree = h.render(); assert.equal(find(tree, node => node.type === 'button' && node.props.className === 'primary').props.disabled, true);
  h.setProps({ owner: ownerB }); tree = h.render();
  assert.equal(find(tree, node => node.type === 'button' && node.props.className === 'primary').props.disabled, true, 'empty new-owner draft remains disabled');
  find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Original task request').props.onChange({ target: { value: 'New owner request' } }); tree = h.render();
  assert.equal(find(tree, node => node.type === 'button' && node.props.className === 'primary').props.disabled, false, 'new owner can send while old call remains unresolved');
  finishSend({ message: 'Old response', monitor: { workspaceId: owner.workspaceId, cwd: owner.cwd, hostId: owner.hostId, conversationId: owner.conversationId } }); await oldSend; tree = h.render();
  assert.doesNotMatch(textOf(tree), /Old response/); assert.equal(find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Original task request').props.value, 'New owner request');
  h.unmount();
});
