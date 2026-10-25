import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'sucrase';
import * as model from '../src/assistantTaskModel.ts';
import * as taskViewModule from '../src/apexAgentTaskView.ts';
import { subscribeToImports } from '../src/legacyImportRefresh.ts';

// A stand-in with its own identity, so "the marker is here" is an assertion about the
// element rather than about a string that happens to be nearby.
const LegacyBadge = function LegacyBadge() { return null; };
const MarkdownStub = function Markdown() { return null; };

// Exports the component imports from the shared Tasks contract. Only these names are passed in, so nothing collides with assistantTaskModel.
const taskViewExports = { TaskViewContext: taskViewModule.TaskViewContext, projectTaskKey: taskViewModule.projectTaskKey, projectTaskGroup: taskViewModule.projectTaskGroup };

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
const textOf = node => { if (node == null || typeof node === 'boolean') return ''; if (node.type === MarkdownStub) return node.props.text; if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(textOf).join(' '); return textOf(node.children ?? []); };
const findAll = (node, predicate, out = []) => { if (!node || typeof node !== 'object') return out; if (Array.isArray(node)) { node.forEach(item => findAll(item, predicate, out)); return out; } if (predicate(node)) out.push(node); (node.children ?? []).forEach(item => findAll(item, predicate, out)); return out; };
const containsNode = (node, target) => node === target || !!(node && typeof node === 'object' && (Array.isArray(node) ? node.some(child => containsNode(child, target)) : (node.children ?? []).some(child => containsNode(child, target))));
// Opens the first task card's details from the conversation.
const openDetail = tree => find(tree, node => node.type === 'button' && /^(Open task|Review result)$/.test(textOf(node)))?.props.onClick();
const button = (tree, label) => find(tree, node => node.type === 'button' && textOf(node) === label);
const NO_CHAT_NOTE = "ApexAgent didn't pick a chat for this. Reply to it with which chat to use.";
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
    // Stands in for <TaskViewContext.Provider value={initial.taskView}>; the Provider needs react-dom, which these tests do not load.
    useContext(context) { return context === taskViewExports.TaskViewContext ? (props.taskView ?? null) : null; },
  };
  const component = new Function('React', ...Object.keys(hooks), ...Object.keys(model), ...Object.keys(taskViewExports), 'subscribeToImports', 'LegacyBadge', 'Markdown', 'window', `${compiled}; return ApexAgentTasks;`)(React, ...Object.values(hooks), ...Object.values(model), ...Object.values(taskViewExports), subscribeToImports, LegacyBadge, MarkdownStub, { crypto: { randomUUID: () => 'request-fixed' }, localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) } });
  props = { backend, owner, panes: [{ id: 'thread-a', title: 'Build room', kind: 'chat', workspaceId: owner.workspaceId }], profiles: [{ id: 'claude', display_name: 'Claude', backend: { kind: 'agent', tool: 'claude_code' }, media: null }], ...initial };
  const render = () => { cursor = 0; const tree = component(props); for (const effect of effects) if (effect?.changed) { effect.changed = false; effect.cleanup?.(); effect.cleanup = effect.fn(); } return tree; };
  return { render, storage: saved, setReviewVisible(visible = true) { observers.at(-1)?.trigger(visible); }, setProps(next) { props = { ...props, ...next }; }, unmount() { mounted = false; effects.forEach(effect => effect?.cleanup?.()); if (previousObserver) globalThis.IntersectionObserver = previousObserver; else delete globalThis.IntersectionObserver; } };
}

test('opening a task shows source request, brief, revision, unknown usage, checks and thread links', async () => {
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
  assert.ok(resultIndex >= 0 && resultIndex < historyIndex && (budgetIndex === -1 || resultIndex < budgetIndex), 'current review material is prioritized before history and spend controls');
  assert.ok(find(tree, node => node.type === 'button' && node.children[0] === 'Accept and mark done'));
  h.unmount();
});

test('the conversation renders no request composer, advanced options, routing, or per-task spend form', async () => {
  const tasks = [task({ status: 'proposed' }), task({ id: 'task-2', status: 'needs_clarification', destination: null }), task({ id: 'task-3', status: 'running' })];
  const h = harness({ demo: false, call: async command => command === 'assistant_tasks_list' ? snapshot(tasks) : null });
  let tree = h.render(); await tick(); tree = h.render();
  openDetail(tree); tree = h.render();
  assert.equal(find(tree, node => node.type === 'form' && node.props.className === 'assistant-request'), null);
  assert.equal(find(tree, node => node.type === 'textarea'), null);
  assert.equal(find(tree, node => node.type === 'select'), null);
  assert.doesNotMatch(textOf(tree), /Advanced options|Choose destination|Execution mode|Spend limit|Set limit|Exact checks/);
  h.unmount();
});

test('a proposal is approved with its own destination, workers and mode, and no routing form is needed', async () => {
  const proposed = task({ status: 'proposed', mode: 'isolated', destination: { threadId: 'thread-a', newThread: false, workers: ['claude'] } }); const actions = [];
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return { ...snapshot([proposed]), routingThreads: [{ id: 'thread-a', workers: [{ id: 'claude', display_name: 'Claude', backend: { kind: 'agent', tool: 'claude_code' }, media: null }] }] }; if (command === 'assistant_task_action') { actions.push(args); return task({ status: 'queued' }); } } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  assert.equal(find(tree, node => node.type === 'select' && node.props['aria-label'] === 'Destination for task-1'), null);
  await button(tree, 'Approve task').props.onClick(); await tick();
  assert.deepEqual(actions[0].destination, { threadId: 'thread-a', newThread: false, workers: ['claude'] });
  assert.deepEqual(actions[0].newWorkerProfiles, []);
  assert.equal(actions[0].mode, 'isolated'); assert.equal(actions[0].action, 'approve'); assert.equal(actions[0].taskId, 'task-1');
  h.unmount();
});

test('a proposal with no usable chat shows the note, hides Approve, and keeps Dismiss working', async () => {
  const actions = [];
  const proposed = task({ status: 'proposed', destination: null, workers: [] });
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([proposed]); if (command === 'assistant_task_action') { actions.push(args); return task({ status: 'done' }); } } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  assert.match(textOf(tree), /didn't pick a chat for this/);
  assert.equal(button(tree, 'Approve task'), null);
  await button(tree, 'Dismiss').props.onClick(); await tick();
  assert.equal(actions[0].action, 'dismiss'); assert.equal(actions[0].taskId, 'task-1');
  h.unmount();
});

test('accept is available only in detail and requires current revision acknowledgement and review criteria', async () => {
  const calls = [];
  const backend = { demo: false, call: async (command, args) => { calls.push([command, args]); if (command === 'assistant_tasks_list') return snapshot([task()]); if (command === 'assistant_task_action') return task({ status: 'done', revision: 5 }); } };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render();
  assert.equal(find(tree, node => node.type === 'button' && /Accept and mark done|Accept changes/.test(String(node.children[0]))), null);
  openDetail(tree); tree = h.render();
  const acceptButton = () => find(tree, node => node.type === 'button' && node.children[0] === 'Accept and mark done');
  assert.equal(acceptButton().props.disabled, true, 'accept stays disabled until the current review result intersects the detail scroll');
  h.setReviewVisible(); tree = h.render();
  assert.equal(acceptButton().props.disabled, true, 'review criteria still required');
  find(tree, node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); tree = h.render();
  assert.equal(acceptButton().props.disabled, false);
  find(tree, node => node.type === 'button' && node.children[0] === 'Accept and mark done').props.onClick(); await tick();
  const action = calls.find(([command]) => command === 'assistant_task_action');
  assert.equal(action[1].taskId, 'task-1'); assert.equal(action[1].revision, 4); assert.deepEqual(action[1].owner, owner); assert.equal(action[1].action, 'accept');
  assert.equal('checks' in action[1], false);
  h.unmount();
});

test('a new task revision invalidates the prior review acknowledgement', async () => {
  const revised = task({ revision: 5, brief: 'Updated after requested changes.' }); let actionDone = false; let sendTask;
  const backend = { demo: false, call: async (command) => { if (command === 'assistant_tasks_list') return snapshot([actionDone ? revised : task()]); if (command === 'assistant_task_action') { actionDone = true; return revised; } return null; } };
  const h = harness(backend, { onSelectTask: (_task, send) => { sendTask = send; } });
  let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render(); h.setReviewVisible(); tree = h.render();
  findAll(tree, node => node.type === 'input' && node.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } }); tree = h.render();
  assert.equal(find(tree, node => node.type === 'button' && node.children[0] === 'Accept and mark done').props.disabled, false);
  await sendTask('Update the output format.'); await tick(); tree = h.render();
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
  assert.equal(find(tree, node => node.type === 'button' && node.children[0] === 'Accept and mark done').props.disabled, true);
  h.setReviewVisible(); tree = h.render();
  findAll(tree, node => node.type === 'input' && node.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } }); tree = h.render();
  await find(tree, node => node.type === 'button' && node.children[0] === 'Accept and mark done').props.onClick(); await tick();
  assert.equal(calls[0].action, 'accept'); h.unmount();

  const reviewOnly = task({ mode: 'read_only', result: 'Reviewed source and found no action needed.', reviewCriteria: [], resultData: {} });
  const readCalls = [];
  const readBackend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([reviewOnly]); if (command === 'assistant_task_action') { readCalls.push(args); return task({ mode: 'read_only', status: 'done', revision: 5, reviewCriteria: [] }); } } };
  const read = harness(readBackend); tree = read.render(); await tick(); tree = read.render(); openDetail(tree); tree = read.render();
  read.setReviewVisible(); tree = read.render();
  assert.equal(find(tree, node => node.type === 'input' && node.props.type === 'checkbox'), null, 'no acknowledgement checkbox');
  assert.equal(find(tree, node => node.type === 'button' && node.children[0] === 'Mark reviewed').props.disabled, false);
  await find(tree, node => node.type === 'button' && node.children[0] === 'Mark reviewed').props.onClick(); await tick();
  assert.equal(readCalls[0].action, 'review'); read.unmount();
});

test('the task reply callback adds a note to the selected task and never reroutes it', async () => {
  const calls = []; let sendTask;
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([task({ status: 'running' })]); if (command === 'assistant_task_action') { calls.push([command, args]); return task({ status: 'running', revision: 5 }); } if (command === 'assistant_message') throw new Error('must not reroute task text'); } };
  const h = harness(backend, { onSelectTask: (_task, send) => { sendTask = send; } }); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  await sendTask('Please also include the failing fixture.'); await tick();
  assert.equal(calls[0][1].action, 'note'); assert.equal(calls[0][1].text, 'Please also include the failing fixture.');
  assert.equal(calls.some(([command]) => command === 'assistant_message'), false);
  h.unmount();
});

test('a failed task reply reports its error and a later reply sends normally', async () => {
  let fail = true; const calls = []; let sendTask;
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([task({ status: 'running' })]); if (command === 'assistant_task_action') { calls.push(args); if (fail) throw new Error('offline'); return task({ status: 'running', revision: 5 }); } } };
  const h = harness(backend, { onSelectTask: (_task, send) => { sendTask = send; } }); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  await assert.rejects(sendTask('Continue with this note.'), /was not sent/); tree = h.render();
  assert.match(textOf(tree), /offline/);
  fail = false; await sendTask('Continue with this note.'); await tick();
  assert.equal(calls.length, 2); assert.equal(calls[1].text, 'Continue with this note.'); h.unmount();
});

test('a review reply requests changes, and a single pending question takes the reply as its answer', async () => {
  const calls = [], answers = []; let sendTask;
  const waiting = task({ status: 'needs_you', resultData: { pendingQuestions: [{ request: 'q-1', questions: [{ header: 'Target', question: 'Which target?', options: [], multi_select: false }] }] } });
  let current = task({ status: 'ready_for_review' });
  const backend = { demo: false, roomAnswer: async (...args) => answers.push(args), call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([current]); if (command === 'assistant_task_action') { calls.push(args); current = task({ ...current, revision: 5 }); return current; } } };
  const h = harness(backend, { onSelectTask: (_task, send) => { sendTask = send; } }); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  await sendTask('Please adjust the output.'); await tick();
  assert.equal(calls[0].action, 'request_changes'); assert.equal(calls[0].text, 'Please adjust the output.');
  h.unmount();

  let answerTask;
  const questionBackend = { demo: false, roomAnswer: async (...args) => answers.push(args), call: async command => command === 'assistant_tasks_list' ? snapshot([waiting]) : null };
  const questionHarness = harness(questionBackend, { onSelectTask: (_task, send) => { answerTask = send; } });
  tree = questionHarness.render(); await tick(); tree = questionHarness.render(); openDetail(tree); questionHarness.render();
  await answerTask('Use the parser target.'); await tick();
  assert.deepEqual(answers[0], ['thread-a', 'q-1', [['Use the parser target.']]]); questionHarness.unmount();
});

test('multi-question waits refuse a single reply and say which answers are missing', async () => {
  const waiting = task({ status: 'needs_you', resultData: { pendingQuestions: [{ request: 'q-1', questions: [{ header: 'One', question: 'One?', options: [], multi_select: false }, { header: 'Two', question: 'Two?', options: [], multi_select: false }] }] } });
  const backend = { demo: false, call: async command => command === 'assistant_tasks_list' ? snapshot([waiting]) : null };
  let sendTask;
  const h = harness(backend, { onSelectTask: (_task, send) => { sendTask = send; } }); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  await assert.rejects(sendTask('Do not lose this.'), /was not sent/); tree = h.render();
  assert.match(textOf(tree), /Complete every question/); h.unmount();
});

test('a routing clarification replies with the task destination, and says so when ApexAgent named no chat', async () => {
  const calls = [];
  const noChat = task({ status: 'needs_clarification', destination: null });
  const withChat = task({ status: 'needs_clarification', destination: { threadId: 'thread-a', newThread: false, workers: ['claude'] } });
  const backendFor = (clarifying) => ({ demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([clarifying]); if (command === 'assistant_task_action') { calls.push(args); return task({ status: 'queued', revision: 5 }); } } });

  let sendTask;
  const none = harness(backendFor(noChat), { onSelectTask: (_task, send) => { sendTask = send; } });
  let tree = none.render(); await tick(); tree = none.render(); openDetail(tree); tree = none.render();
  await assert.rejects(sendTask('Route to the parser worker.'), /was not sent/); tree = none.render();
  assert.match(textOf(tree), /didn't pick a chat for this/); assert.equal(calls.length, 0); none.unmount();

  const some = harness(backendFor(withChat), { onSelectTask: (_task, send) => { sendTask = send; } });
  tree = some.render(); await tick(); tree = some.render(); openDetail(tree); some.render();
  await sendTask('Route to the parser worker.'); await tick();
  assert.equal(calls[0].action, 'clarify'); assert.deepEqual(calls[0].destination, { threadId: 'thread-a', newThread: false, workers: ['claude'] }); some.unmount();
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
  assert.doesNotMatch(textOf(tree), /Fix parser/);
  h.unmount();
  const wrongHost = task({ owner: { ...owner, hostId: 'wrong-host' } });
  const bad = harness({ demo: false, call: async () => snapshot([wrongHost]) }); tree = bad.render(); await tick(); tree = bad.render();
  assert.match(textOf(tree), /different project folder or machine/); assert.doesNotMatch(textOf(tree), /Fix parser/);
  bad.unmount();
});

test('an uncertain request keeps its saved ID and text, and Retry sends that same request', async () => {
  const calls = []; let attempts = 0;
  const pending = { requestId: 'req-1', owner, text: 'Please repair the parser.', destination: { threadId: 'thread-a', newThread: false, workers: [] }, newWorkerProfiles: [], mode: 'in_place', checks: [] };
  const saved = new Map([[model.pendingRequestStorageKey(owner), JSON.stringify(pending)]]);
  const returnedMonitor = { workspaceId: owner.workspaceId, hostId: owner.hostId, cwd: owner.cwd, conversationId: owner.conversationId };
  const backend = { demo: false, call: async (command, args) => {
    if (command === 'assistant_tasks_list') return snapshot([]);
    if (command === 'assistant_message') { calls.push(args); if (!attempts++) throw new Error('connection lost'); return { message: 'Saved', monitor: returnedMonitor }; }
  } };
  const h = harness(backend, { onMonitorUpdate() {} }, saved); let tree = h.render(); await tick(); tree = h.render();
  await button(tree, 'Retry request').props.onClick(); tree = h.render();
  assert.match(textOf(tree), /connection lost/); assert.match(textOf(tree), /Please repair the parser\./);
  await button(tree, 'Retry request').props.onClick(); tree = h.render();
  assert.equal(calls.length, 2); assert.equal(calls[0].requestId, 'req-1'); assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].text, 'Please repair the parser.'); assert.equal(calls[0].destination.threadId, 'thread-a');
  assert.deepEqual(calls[0].threadLabels, [{ id: 'thread-a', label: 'Build room' }]);
  assert.equal(saved.has(model.pendingRequestStorageKey(owner)), false);
  h.unmount();
});

test('new destination in a retried request is not treated as an implicit worker choice', async () => {
  const calls = [];
  const pending = { requestId: 'new-thread', owner, text: 'Start a worker.', destination: { threadId: null, newThread: true, workers: ['claude'] }, newWorkerProfiles: [{ id: 'claude', display_name: 'Claude', backend: { kind: 'agent', tool: 'claude_code' }, media: null }], mode: 'in_place', checks: [] };
  const saved = new Map([[model.pendingRequestStorageKey(owner), JSON.stringify(pending)]]);
  const returnedMonitor = { workspaceId: owner.workspaceId, hostId: owner.hostId, cwd: owner.cwd, conversationId: owner.conversationId };
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([]); if (command === 'assistant_message') { calls.push(args); return { message: 'Queued', monitor: returnedMonitor }; } } };
  const h = harness(backend, { onMonitorUpdate() {} }, saved); let tree = h.render(); await tick(); tree = h.render();
  await button(tree, 'Retry request').props.onClick();
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

test('a task from another assignment in a retried reply is rejected and the request stays retryable', async () => {
  const monitor = { workspaceId: owner.workspaceId, cwd: owner.cwd, hostId: owner.hostId, conversationId: owner.conversationId };
  const pending = { requestId: 'wrong-owner-request', owner, text: 'Keep retryable', destination: null, newWorkerProfiles: [], mode: 'in_place', checks: [] };
  const saved = new Map([[model.pendingRequestStorageKey(owner), JSON.stringify(pending)]]);
  const backend = { demo: false, call: async command => command === 'assistant_tasks_list' ? snapshot([]) : ({ message: 'Looks done', monitor, task: task({ owner: { ...owner, conversationId: 'other' } }) }) };
  const h = harness(backend, { onMonitorUpdate() {} }, saved); let tree = h.render(); await tick(); tree = h.render();
  await button(tree, 'Retry request').props.onClick(); tree = h.render();
  assert.match(textOf(tree), /task for a different assignment/); assert.match(textOf(tree), /Keep retryable/);
  assert.ok(button(tree, 'Retry request'));
  h.unmount();
});

test('reassigning the component ignores a late response from the previous owner', async () => {
  let finishSend; const ownerB = { workspaceId: 'project-b', cwd: '/work/b', hostId: 'host-b', conversationId: 'monitor-b' };
  const pending = { requestId: 'old-request', owner, text: 'Old owner request', destination: null, newWorkerProfiles: [], mode: 'in_place', checks: [] };
  const saved = new Map([[model.pendingRequestStorageKey(owner), JSON.stringify(pending)]]);
  const backend = { demo: false, call: async (command) => {
    if (command === 'assistant_tasks_list') return { workspaceId: ownerB.workspaceId, revision: 1, tasks: [], executions: [] };
    if (command === 'assistant_message') return new Promise(resolve => { finishSend = resolve; });
  } };
  const h = harness(backend, { onMonitorUpdate() {} }, saved); let tree = h.render(); await tick(); tree = h.render();
  const pendingRetry = button(tree, 'Retry request').props.onClick(); tree = h.render();
  h.setProps({ owner: ownerB }); tree = h.render();
  assert.equal(button(tree, 'Retry request'), null, 'the previous owner’s saved request is not offered to the new owner');
  finishSend({ message: 'Old response', monitor: { workspaceId: owner.workspaceId, cwd: owner.cwd, hostId: owner.hostId, conversationId: owner.conversationId } }); await pendingRetry; tree = h.render();
  assert.doesNotMatch(textOf(tree), /Old response/);
  h.unmount();
});

test('conversation task messages open approval and review controls without tabs', async () => {
  const calls = [];
  const h = harness({ demo: false, call: async (command, args) => { calls.push([command, args]); return snapshot([task()]); } }, { view: 'conversation' });
  let tree = h.render(); await tick(); tree = h.render();
  assert.equal(find(tree, node => node.type === 'h2' && textOf(node) === 'Task overview'), null);
  const card = find(tree, node => node.type === 'article' && textOf(node).includes('Fix parser'));
  const message = card && find(card, node => node.type === 'button' && ['Open task', 'Review result'].includes(textOf(node)));
  assert.ok(message); message.props.onClick(); tree = h.render();
  assert.match(textOf(tree), /diff --git a\/parser.ts/);
  const accept = find(tree, node => node.type === 'button' && textOf(node) === 'Accept and mark done');
  assert.ok(accept); assert.equal(accept.props.disabled, true);
  h.setReviewVisible(); tree = h.render();
  assert.equal(find(tree, node => node.props?.className === 'assistant-review-ack'), null);
  tree = h.render(); assert.match(textOf(tree), /Tests pass/); h.unmount();
});

test('worker approvals are reachable from conversation messages and keep the exact request ID', async () => {
  const waiting = task({ status: 'needs_you', resultData: { pendingApprovals: [{ request: 'approval-v4', action: { title: 'Run tests', detail: 'npm test' } }] } });
  const decisions = [];
  const h = harness({ demo: false, call: async () => snapshot([waiting]), roomDecide: async (...args) => decisions.push(args) }, { view: 'conversation' });
  let tree = h.render(); await tick(); tree = h.render();
  find(tree, node => node.type === 'button' && /^Open task/.test(textOf(node))).props.onClick(); tree = h.render();
  assert.match(textOf(tree), /npm test/);
  find(tree, node => node.type === 'button' && textOf(node) === 'Approve').props.onClick(); await tick();
  assert.deepEqual(decisions, [['thread-a', 'approval-v4', true, false]]); h.unmount();
});

test('conversation task selects a shared composer callback without another textarea', async () => {
  const calls = [], selected = [];
  const running = task({ status: 'running' });
  const h = harness({ demo: false, call: async (command, args) => { if (command === 'assistant_task_action') { calls.push(args); return running; } return snapshot([running]); } }, { view: 'conversation', onSelectTask: (...args) => selected.push(args) });
  let tree = h.render(); await tick(); tree = h.render();
  find(tree, node => node.type === 'button' && /^Open task/.test(textOf(node))).props.onClick(); tree = h.render();
  assert.equal(find(tree, node => node.type === 'textarea'), null);
  assert.equal(selected[0][0].id, running.id);
  await selected[0][1]('Continue on the selected task');
  assert.equal(calls[0].action, 'note'); assert.equal(calls[0].revision, running.revision);
  h.unmount();
});

test('shared task callback follows its current revision and rejects a changed owner', async () => {
  const calls = []; let send; let current = task({ status: 'running' });
  const h = harness({ demo: false, call: async (command, args) => {
    if (command === 'assistant_task_action') { calls.push(args); current = { ...current, revision: current.revision + 1 }; return current; }
    return { ...snapshot([current]), revision: current.revision };
  } }, { view: 'conversation', onSelectTask: (_task, callback) => { send = callback; } });
  let tree = h.render(); await tick(); tree = h.render();
  find(tree, node => node.type === 'button' && /^Open task/.test(textOf(node))).props.onClick(); h.render();
  await send('First note'); await tick(); h.render(); await send('Second note');
  assert.deepEqual(calls.map(call => call.revision), [4, 5]);
  h.setProps({ owner: { ...owner, hostId: 'changed-host' } }); h.render();
  await assert.rejects(send('Stale owner note'), /assignment changed/);
  assert.equal(calls.length, 2); h.unmount();
});

test('proposed handoff shows original scope and batch, and approves with the proposed workers', async () => {
  const actions = []; const proposed = task({ status: 'proposed', mode: 'isolated', resultData: { batchId: 'batch-7', requestId: 'child-7' } });
  const h = harness({ demo: false, call: async (command, args) => { if (command === 'assistant_task_action') { actions.push(args); return { ...proposed, status: 'queued' }; } return { ...snapshot([proposed]), routingThreads: [{ id: 'thread-a', workers: [{ id: 'claude', display_name: 'Claude' }] }] }; } }, { view: 'conversation' });
  let tree = h.render(); await tick(); tree = h.render();
  assert.match(textOf(tree), /From your cross-project plan/); assert.doesNotMatch(textOf(tree), /batch-7/); assert.match(textOf(tree), /Scope:.*Repair the parser/);
  find(tree, node => node.type === 'button' && /^Open task/.test(textOf(node))).props.onClick(); tree = h.render();
  assert.equal(find(tree, node => node.type === 'select'), null);
  const approve = find(tree, node => node.type === 'button' && textOf(node) === 'Approve task');
  assert.equal(approve.props.disabled, false); approve.props.onClick(); await tick();
  assert.equal(actions[0].mode, 'isolated'); assert.deepEqual(actions[0].destination, { threadId: 'thread-a', newThread: false, workers: ['claude'] }); h.unmount();
});

test('host saved routing is approvable without a locally open pane', async () => {
  const actions = [];
  const proposed = task({ status: 'proposed', mode: 'isolated', destination: { threadId: 'saved-remote-chat', newThread: false, workers: ['claude'] } });
  const h = harness({ demo: false, call: async (command, args) => {
    if (command === 'assistant_task_action') { actions.push(args); return { ...proposed, status: 'queued' }; }
    return { ...snapshot([proposed]), routingThreads: [{ id: 'saved-remote-chat', workers: [{ id: 'claude', display_name: 'Claude' }] }] };
  } }, { view: 'conversation', panes: [] });
  let tree = h.render(); await tick(); tree = h.render();
  find(tree, node => node.type === 'button' && /^Open task/.test(textOf(node))).props.onClick(); tree = h.render();
  const approve = find(tree, node => node.type === 'button' && textOf(node) === 'Approve task');
  assert.equal(approve.props.disabled, false); approve.props.onClick(); await tick();
  assert.deepEqual(actions[0].destination, proposed.destination); assert.deepEqual(actions[0].owner, owner); h.unmount();
});

test('saved destination approval sends no local same-id worker configuration', async () => {
  const actions = [];
  const proposed = task({ status: 'proposed', mode: 'isolated', destination: { threadId: 'remote-chat', newThread: false, workers: ['claude'] } });
  const h = harness({ demo: false, call: async (command, args) => {
    if (command === 'assistant_task_action') { actions.push(args); return { ...proposed, status: 'queued' }; }
    return { ...snapshot([proposed]), routingThreads: [{ id: 'remote-chat', workers: [{ id: 'claude', display_name: 'Remote worker', backend: { kind: 'agent', tool: 'codex' } }] }] };
  } }, { view: 'conversation', profiles: [{ id: 'claude', display_name: 'Local worker', backend: { kind: 'agent', tool: 'claude_code' }, media: null }] });
  let tree = h.render(); await tick(); tree = h.render();
  find(tree, node => node.type === 'button' && /^Open task/.test(textOf(node))).props.onClick(); tree = h.render();
  const approve = find(tree, node => node.type === 'button' && textOf(node) === 'Approve task');
  approve.props.onClick(); await tick();
  assert.deepEqual(actions[0].destination, proposed.destination);
  assert.deepEqual(actions[0].newWorkerProfiles, []);
  h.unmount();
});

test('restored failed project request exposes Retry and Discard in the single conversation', async () => {
  const pending = { requestId: 'lost', owner, text: 'Check parser', destination: null, newWorkerProfiles: [], mode: 'in_place', checks: [], threadLabels: [{ id: 'thread-a', label: 'Original title' }] };
  const saved = new Map([[model.pendingRequestStorageKey(owner), JSON.stringify(pending)]]);
  const calls = [];
  const h = harness({ demo: false, call: async (command, args) => {
    if (command === 'assistant_message') { calls.push(args); throw new Error('still offline'); }
    return snapshot();
  } }, { view: 'conversation', projectName: 'Parser project', clearedAt: Date.now() }, saved);
  let tree = h.render(); await tick(); tree = h.render();
  assert.match(textOf(tree), /Parser project/); assert.match(textOf(tree), /Check parser/);
  const retry = () => find(tree, node => node.type === 'button' && textOf(node) === 'Retry request');
  assert.ok(retry());
  await retry().props.onClick(); tree = h.render();
  await retry().props.onClick(); tree = h.render();
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].requestId, 'lost'); assert.equal(calls[0].text, 'Check parser');
  assert.deepEqual(calls[0].threadLabels, pending.threadLabels);
  find(tree, node => node.type === 'button' && /Discard saved/.test(textOf(node))).props.onClick();
  tree = h.render(); assert.equal(saved.has(model.pendingRequestStorageKey(owner)), false);
  assert.equal(retry(), null); h.unmount();
});

test('single-conversation recovery survives reopen and successful retry removes the saved request', async () => {
  const pending = { requestId: 'restart-request', owner, text: 'Keep this original message', destination: null, newWorkerProfiles: [], mode: 'in_place', checks: [] };
  const saved = new Map([[model.pendingRequestStorageKey(owner), JSON.stringify(pending)]]);
  const calls = [];
  const backend = { demo: false, call: async (command, args) => {
    if (command === 'assistant_message') { calls.push(args); return { message: 'Confirmed', monitor: owner }; }
    return snapshot();
  } };
  const first = harness(backend, { view: 'conversation' }, saved); first.render(); await tick(); first.unmount();
  const reopened = harness(backend, { view: 'conversation' }, saved);
  let tree = reopened.render(); await tick(); tree = reopened.render();
  await find(tree, node => node.type === 'button' && textOf(node) === 'Retry request').props.onClick(); tree = reopened.render();
  assert.equal(calls[0].requestId, 'restart-request'); assert.equal(calls[0].text, pending.text);
  assert.equal(saved.has(model.pendingRequestStorageKey(owner)), false);
  assert.equal(find(tree, node => node.type === 'button' && textOf(node) === 'Retry request'), null); reopened.unmount();
});

const projectKey = id => `project:${owner.hostId}:${owner.workspaceId}:${id}`;

test('sidebar rows open local task details and Back restores the compact list without dispatching or binding a composer', async () => {
  const calls = [], selected = [], opened = [];
  const tasks = [task(), task({ id: 'task-2', status: 'running', originalRequest: 'Review docs' })];
  const backend = { demo: false, call: async command => { calls.push(command); return snapshot(tasks); } };
  const h = harness(backend, { view: 'sidebar', projectName: 'apex-deck', clearedAt: 10, onSelectTask: (...args) => selected.push(args), taskView: { display: 'tasks', selectedKey: projectKey('task-2'), openTask: key => opened.push(key), report() {} } });
  let tree = h.render(); await tick(); tree = h.render();
  const rows = findAll(tree, node => node.type === 'button' && node.props.className === 'assistant-task-sidebar-row');
  assert.equal(rows.length, 2);
  assert.match(textOf(tree), /apex-deck/);
  assert.match(textOf(rows[0]), /Fix parser.*Claude.*Ready for review/);
  assert.match(textOf(rows[1]), /Review docs.*Running/);
  assert.equal(find(tree, node => node.props.className === 'assistant-task-detail-scroll'), null);
  assert.equal(button(tree, 'Approve task'), null);
  const before = calls.length;
  rows[0].props.onClick(); tree = h.render();
  assert.ok(button(tree, 'Accept and mark done'));
  assert.ok(button(tree, 'Request changes…'), 'the compact sidebar retains the existing explicit review actions');
  assert.equal(find(tree, node => node.props.className === 'assistant-task-sidebar-row'), null);
  assert.equal(calls.length, before);
  assert.deepEqual(selected, []); assert.deepEqual(opened, []);
  button(tree, 'Back to tasks').props.onClick(); tree = h.render();
  assert.equal(findAll(tree, node => node.props.className === 'assistant-task-sidebar-row').length, 2);
  assert.equal(find(tree, node => node.props.className === 'assistant-task-detail-scroll'), null);
  assert.equal(calls.length, before);
  h.unmount();
});

test('sidebar statuses follow task events and a changed owner cannot keep or open the prior assignment', async () => {
  let changed, revision = 1, status = 'running';
  const ownerB = { workspaceId: 'project-b', cwd: '/work/b', hostId: 'host-b', conversationId: 'monitor-b' };
  const backend = { demo: false, onAssistantTasksChanged: async listener => { changed = listener; return () => {}; }, call: async (_command, args) => args.owner.workspaceId === owner.workspaceId ? { ...snapshot([task({ status })]), revision } : { workspaceId: ownerB.workspaceId, revision: 1, tasks: [], executions: [] } };
  const h = harness(backend, { view: 'sidebar' }); let tree = h.render(); await tick(); tree = h.render();
  let row = find(tree, node => node.props.className === 'assistant-task-sidebar-row');
  assert.ok(row); assert.match(textOf(row), /Running/);
  status = 'needs_you'; revision++; changed({ workspaceId: owner.workspaceId }); await tick(); tree = h.render();
  row = find(tree, node => node.props.className === 'assistant-task-sidebar-row');
  assert.match(textOf(row), /Needs you/);
  row.props.onClick(); tree = h.render(); assert.ok(button(tree, 'Cancel task'));
  h.setProps({ owner: ownerB }); tree = h.render();
  assert.doesNotMatch(textOf(tree), /Fix parser/);
  row.props.onClick(); await tick(); tree = h.render();
  assert.equal(find(tree, node => node.props.className === 'assistant-task-detail-scroll'), null);
  assert.doesNotMatch(textOf(tree), /Fix parser/);
  assert.match(textOf(tree), /No tasks for this project/);
  h.unmount();
});

test('sidebar distinguishes loading, empty and failed task lists and keeps request recovery accessible', async () => {
  let finishList;
  const loading = harness({ demo: false, call: () => new Promise(resolve => { finishList = resolve; }) }, { view: 'sidebar' });
  let tree = loading.render(); assert.match(textOf(tree), /Loading tasks/); assert.doesNotMatch(textOf(tree), /No tasks for this project/);
  finishList(snapshot([])); await tick(); tree = loading.render(); assert.match(textOf(tree), /No tasks for this project/); loading.unmount();
  const failed = harness({ demo: false, call: async () => { throw new Error('Machine is offline'); } }, { view: 'sidebar' });
  failed.render(); await tick(); tree = failed.render();
  assert.match(textOf(find(tree, node => node.props.role === 'alert')), /Machine is offline/);
  assert.doesNotMatch(textOf(tree), /No tasks for this project/); failed.unmount();
  let discarded = false;
  const pending = { requestId: 'saved', owner, text: 'Keep my saved request', destination: null, newWorkerProfiles: [], mode: 'in_place', checks: [] };
  const recovery = harness({ demo: false, call: async () => snapshot([]) }, { view: 'sidebar', requestRecovery: { pending, retry: async () => {}, discard: () => { discarded = true; } } });
  recovery.render(); await tick(); tree = recovery.render();
  assert.match(textOf(tree), /Keep my saved request/);
  button(tree, 'Discard saved request and start over').props.onClick(); assert.equal(discarded, true); recovery.unmount();
});

test('links view: one short line per task, no cards or detail, and opening makes no backend call', async () => {
  const calls = []; const opened = []; const selected = [];
  const tasks = [
    task({ id: 'task-1', status: 'running', originalRequest: 'Fix parser' }),
    task({ id: 'task-2', status: 'ready_for_review', originalRequest: 'Review docs' }),
    task({ id: 'task-3', status: 'done', originalRequest: 'Ship notes', result: 'Notes shipped.' }),
  ];
  const view = { display: 'links', selectedKey: null, openTask: key => opened.push(key), report() {} };
  const backend = { demo: false, call: async command => { calls.push(command); return command === 'assistant_tasks_list' ? snapshot(tasks) : null; } };
  const h = harness(backend, { taskView: view, onSelectTask: (...args) => selected.push(args) });
  let tree = h.render(); await tick(); tree = h.render();
  const links = findAll(tree, node => node.type === 'button' && node.props.className === 'assistant-task-link');
  assert.equal(links.length, 3);
  assert.equal(textOf(links[0]).trim(), 'Task · Running · Fix parser ›');
  assert.equal(textOf(links[1]).trim(), 'Review result · Review docs ›');
  assert.equal(textOf(links[2]).trim(), 'Result ready · Ship notes ›');
  assert.equal(findAll(tree, node => node.type === 'article' && node.props.className?.startsWith?.('assistant-task-card')).length, 0);
  assert.equal(find(tree, node => node.props.className === 'assistant-task-detail-scroll'), null);
  assert.equal(find(tree, node => node.type === 'button' && /^(Open task|Review result)$/.test(textOf(node))), null);
  const before = calls.length;
  links[0].props.onClick(); await tick(); tree = h.render();
  assert.deepEqual(opened, [projectKey('task-1')]);
  assert.equal(calls.length, before, 'opening a task from the conversation makes no backend call');
  assert.equal(selected.length, 0, 'opening a task never binds the composer');
  assert.equal(find(tree, node => node.props.className === 'assistant-task-detail-scroll'), null);
  h.unmount();
});

test('report() receives composite keys, groups, and cleaned results, and empties on unmount', async () => {
  const reports = [];
  const tasks = [
    task({ id: 'task-1', status: 'proposed', originalRequest: 'Plan the release', result: null, destination: { threadId: 'thread-a', newThread: false, workers: ['claude'] } }),
    task({ id: 'task-2', status: 'running', originalRequest: 'Fix   the\nparser', result: null, destination: null, workers: [] }),
    task({ id: 'task-3', status: 'done', originalRequest: 'Ship notes', result: '```\n<result>Shipped the fix.</result>\n```', updatedAtMs: 9 }),
    task({ id: 'task-4', status: 'done', originalRequest: 'Old work', resultData: { dismissedAtMs: 5 } }),
  ];
  const view = { display: 'links', selectedKey: null, openTask() {}, report: (storeKey, rows) => reports.push({ storeKey, rows }) };
  const backend = { demo: false, call: async command => command === 'assistant_tasks_list' ? snapshot(tasks) : null };
  const h = harness(backend, { taskView: view, projectName: 'apex-deck' });
  let tree = h.render(); await tick(); tree = h.render();
  const latest = reports.filter(report => report.storeKey === 'project:host-a:project').at(-1);
  assert.ok(latest, 'the store reports under its project key');
  const rows = latest.rows;
  assert.deepEqual(rows.map(row => row.key), [projectKey('task-1'), projectKey('task-2'), projectKey('task-3')], 'dismissed tasks are not reported');
  assert.deepEqual(rows.map(row => row.group), ['needsYou', 'active', 'finished']);
  assert.deepEqual(rows.map(row => row.worker), ['Claude', 'Not chosen yet', 'Claude'], 'worker shows the profile display name');
  assert.deepEqual(rows.map(row => row.result), ['', '', 'Shipped the fix.']);
  assert.equal(rows[1].title, 'Fix the parser');
  assert.equal(rows[0].statusLabel, 'Proposed');
  assert.deepEqual({ source: rows[0].source, hostId: rows[0].hostId, workspaceId: rows[0].workspaceId, id: rows[0].id, place: rows[0].place, updatedAt: rows[2].updatedAt }, { source: 'project', hostId: 'host-a', workspaceId: 'project', id: 'task-1', place: 'apex-deck', updatedAt: 9 });
  h.unmount();
  assert.deepEqual(reports.at(-1), { storeKey: 'project:host-a:project', rows: [] }, 'unmounting reports an empty list for this store');
});

test('tasks view renders only the selected task detail, result first, and never binds the composer', async () => {
  const selected = [];
  const tasks = [task({ id: 'task-1', status: 'ready_for_review' }), task({ id: 'task-2', status: 'running', originalRequest: 'Other work' })];
  const view = { display: 'tasks', selectedKey: projectKey('task-1'), openTask() {}, report() {} };
  const backend = { demo: false, call: async command => command === 'assistant_tasks_list' ? snapshot(tasks) : null };
  const h = harness(backend, { taskView: view, onSelectTask: (...args) => selected.push(args) });
  let tree = h.render(); await tick(); tree = h.render();
  assert.equal(findAll(tree, node => node.type === 'article' && node.props.className?.startsWith?.('assistant-task-card')).length, 1);
  assert.match(textOf(tree), /Repair the parser/); assert.doesNotMatch(textOf(tree), /Other work/);
  assert.equal(find(tree, node => node.props.className === 'assistant-task-link'), null);
  assert.equal(button(tree, 'Close task details'), null, 'the parent provides Back, so no close button here');
  const title = find(tree, node => node.props.className === 'assistant-task-title');
  assert.equal(title.props.id, 'assistant-task-title-task-1'); assert.equal(title.props.tabIndex, -1);
  const scroll = find(tree, node => node.props.className === 'assistant-task-detail-scroll');
  const resultIndex = scroll.children.findIndex(node => node?.props?.className === 'assistant-task-result-block');
  const originalIndex = scroll.children.findIndex(node => node?.type === 'details');
  assert.ok(resultIndex === 0 && resultIndex < originalIndex, 'the result block is the first thing in the detail');
  const resultBlock = find(tree, node => node.props.className === 'assistant-task-result-block');
  assert.match(textOf(resultBlock), /Parser repaired\./); assert.match(textOf(resultBlock), /Not verified/); assert.match(textOf(resultBlock), /Finished|Updated/);
  assert.ok(button(tree, 'Open worker chat'));
  assert.equal(find(tree, node => node.type === 'textarea'), null, 'no composer textarea appears in the detail for a ready task until Request changes is opened');
  assert.equal(selected.length, 0, 'selecting a task never retargets the message box');
  h.unmount();
});

test('request changes is sent only from the explicit button after its text is entered', async () => {
  const calls = [];
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([task()]); if (command === 'assistant_task_action') { calls.push(args); return task({ status: 'queued', revision: 5 }); } return null; } };
  const view = { display: 'tasks', selectedKey: projectKey('task-1'), openTask() {}, report() {} };
  const h = harness(backend, { taskView: view }); let tree = h.render(); await tick(); tree = h.render();
  assert.equal(calls.length, 0);
  button(tree, 'Request changes…').props.onClick(); tree = h.render();
  assert.equal(calls.length, 0, 'revealing the box is not a request');
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Use the sharper wording.' } }); tree = h.render();
  assert.equal(find(tree, node => node.type === 'textarea').props.value, 'Use the sharper wording.', 'typed text survives re-renders');
  assert.equal(calls.length, 0, 'typing is not a request');
  await button(tree, 'Send change request to Claude').props.onClick(); await tick(); tree = h.render();
  assert.equal(calls.length, 1); assert.equal(calls[0].action, 'request_changes'); assert.equal(calls[0].taskId, 'task-1');
  assert.equal(calls[0].text, 'Use the sharper wording.');
  h.unmount();
});

test('a running task note goes to the explicit note box as a note action', async () => {
  const calls = [];
  const backend = { demo: false, call: async (command, args) => { if (command === 'assistant_tasks_list') return snapshot([task({ status: 'running' })]); if (command === 'assistant_task_action') { calls.push(args); return task({ status: 'running', revision: 5 }); } return null; } };
  const view = { display: 'tasks', selectedKey: projectKey('task-1'), openTask() {}, report() {} };
  const h = harness(backend, { taskView: view }); let tree = h.render(); await tick(); tree = h.render();
  assert.match(textOf(tree), /Add a note for the worker/);
  assert.equal(button(tree, 'Request changes…'), null);
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Include the fixture.' } }); tree = h.render();
  await button(tree, 'Send note').props.onClick(); await tick();
  assert.equal(calls[0].action, 'note'); assert.equal(calls[0].text, 'Include the fixture.');
  h.unmount();
});

test('an imported task is marked unverified and names its saved folder before a retry', async () => {
  const marker = { sourceSha256: 'a'.repeat(64), importedAtMs: 1, originalId: 't-1', originalStatus: 'queued', verified: false };
  const imported = task({ id: 'legacy-1', status: 'interrupted', executionThreadId: null, legacy: marker });
  const backend = { demo: false, call: async command => command === 'assistant_tasks_list' ? snapshot([imported]) : null };

  // The sidebar row states the status, so it states the marker with it.
  const list = harness(backend, { view: 'sidebar' }); let rows = list.render(); await tick(); rows = list.render();
  assert.ok(findAll(rows, node => node.type === LegacyBadge).length > 0, 'the list marks the imported task');

  // The card detail states the status too, and carries the folder before a retry.
  const card = harness(backend); let tree = card.render(); await tick(); tree = card.render();
  openDetail(tree); tree = card.render();
  const shown = textOf(tree);
  assert.ok(findAll(tree, node => node.type === LegacyBadge).length > 0, 'the detail carries the marker');
  assert.match(shown, /Came from an older copy/);
  assert.match(shown, /\/work\/project/, 'the folder it was saved for is named before a retry');

  // A task this machine wrote is marked nowhere and gets no folder warning.
  const clean = { demo: false, call: async command => command === 'assistant_tasks_list' ? snapshot([task({ legacy: null })]) : null };
  const fresh = harness(clean); let other = fresh.render(); await tick(); other = fresh.render();
  openDetail(other); other = fresh.render();
  assert.equal(findAll(other, node => node.type === LegacyBadge).length, 0, 'a task from this machine is not marked');
  assert.ok(!/Came from an older copy/.test(textOf(other)));
});

test('imported tasks stay visibly unverified in conversation summaries and task links', async () => {
 const marker={sourceSha256:'a'.repeat(64),importedAtMs:1,verified:false};
 const backend={demo:false,call:async cmd=>cmd==='assistant_tasks_list'?snapshot([task({legacy:marker})]):null};
 for(const props of [{},{taskView:{display:'links',selectedKey:null,openTask(){},report(){}}}]){
  const h=harness(backend,props);h.render();await tick();const tree=h.render();
  assert.ok(find(tree,node=>node.type===LegacyBadge),'status summary must preserve imported marker');
 }
});

test('an imported conversation receipt is read-only and never offers request retry', async () => {
 const pending={requestId:'old-request',owner,text:'Old request',destination:null,newWorkerProfiles:[],mode:'in_place',checks:[]};
 const saved=new Map([[model.pendingRequestStorageKey(owner),JSON.stringify(pending)]]);let dispatched=0;
 const backend={demo:false,call:async cmd=>{if(cmd==='assistant_tasks_list')return {...snapshot(),request:{requestId:'old-request',status:'legacy'}};dispatched++;return null;}};
 const h=harness(backend,{},saved);h.render();await tick();const tree=h.render();
 assert.equal(button(tree,'Retry request'),null);assert.match(textOf(tree),/read.only|Older records/i);
 assert.ok(find(tree,node=>node.type===LegacyBadge));assert.equal(dispatched,0);h.unmount();
});

test('task Pause and Resume send exact-owner controls and require explicit retry after interruption', async () => {
  let current = task({status:'running',desiredState:'running'});
  const calls=[];
  const backend={demo:false,call:async(command,args)=>{
    if(command==='assistant_tasks_list') return snapshot([current]);
    if(command==='assistant_task_action') {
      calls.push(args);
      current=task({status:'interrupted',desiredState:args.action==='pause'?'paused':'running',pauseReason:args.action==='pause'?'manual':null,revision:current.revision+1,result:'This adapter cannot checkpoint. Retry starts a new attempt.'});
      return current;
    }
  }};
  const h=harness(backend);
  let tree=h.render(); await tick(); tree=h.render(); openDetail(tree); tree=h.render();
  assert.ok(button(tree,'Pause task'));
  await button(tree,'Pause task').props.onClick(); await tick(); tree=h.render();
  assert.equal(calls[0].action,'pause'); assert.deepEqual(calls[0].owner,owner); assert.equal(calls[0].revision,4);
  assert.ok(button(tree,'Resume task')); assert.equal(button(tree,'Retry task').props.disabled,true);
  await button(tree,'Resume task').props.onClick(); await tick(); tree=h.render();
  assert.equal(calls[1].action,'resume'); assert.equal(calls[1].revision,5);
  assert.equal(calls.length,2,'Resume cannot implicitly retry an unsupported adapter');
  assert.equal(button(tree,'Retry task').props.disabled,false);
  h.unmount();
});

test('owned task responses show the named assistant while retaining the worker identity',async()=>{
 const ref={hostId:'host-a',assistantId:'named-1'};
 const named=task({lineage:{assistant:ref,project:{hostId:'host-a',workspaceId:owner.workspaceId,cwd:owner.cwd}}});
 const backend={demo:false,call:async command=>command==='assistant_tasks_list'?snapshot([named]):null};
 const h=harness(backend,{assistantIdentity:{ref,name:'Apex Assistant'},taskView:{display:'tasks',selectedKey:taskViewModule.projectTaskKey(owner.hostId,owner.workspaceId,'task-1'),report(){},openTask(){}}});h.render();await tick();let tree=h.render();openDetail(tree);tree=h.render();
 assert.match(textOf(tree),/Apex Assistant\s+·\s+Task response/);
 assert.match(textOf(tree),/Worker: Claude/);
 h.setProps({assistantIdentity:{ref,name:'Renamed Assistant'}});tree=h.render();assert.match(textOf(tree),/Renamed Assistant\s+·\s+Task response/);assert.doesNotMatch(textOf(tree),/Apex Assistant\s+·\s+Task response/);
 h.setProps({assistantIdentity:{ref:{...ref,assistantId:'other'},name:'Other Assistant'}});tree=h.render();assert.doesNotMatch(textOf(tree),/Other Assistant\s+·\s+Task response/);h.unmount();
});

test('review is one step: no acknowledgement checkbox, button waits for the visible current result', async () => {
  const backend = { demo: false, call: async (command) => command === 'assistant_tasks_list' ? snapshot([task({ reviewCriteria: [] })]) : null };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  assert.equal(find(tree, node => node.props?.className === 'assistant-review-ack'), null);
  assert.doesNotMatch(textOf(tree), /I opened and reviewed/);
  assert.equal(find(tree, node => node.type === 'button' && node.children[0] === 'Accept and mark done').props.disabled, true);
  h.setReviewVisible(); tree = h.render();
  assert.equal(find(tree, node => node.type === 'button' && node.children[0] === 'Accept and mark done').props.disabled, false);
  h.unmount();
});

test('task results render as formatted text', async () => {
  const backend = { demo: false, call: async (command) => command === 'assistant_tasks_list' ? snapshot([task({ result: '**Fix first:** prune rows' })]) : null };
  const h = harness(backend); let tree = h.render(); await tick(); tree = h.render(); openDetail(tree); tree = h.render();
  assert.ok(find(tree, node => node.type === MarkdownStub && node.props.text === '**Fix first:** prune rows'));
  h.unmount();
});
