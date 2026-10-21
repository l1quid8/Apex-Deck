import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { laneMentions, mentionedLane, mentionsAll, mergeProjectConversations, replyTarget, withoutLaneMentions } from '../src/apexAgentModel.ts';
import { TaskViewContext, personalTaskGroup, personalTaskKey } from '../src/apexAgentTaskView.ts';
import { messageStateKey, retryMessageText } from '../src/apexAgentMessageControls.ts';
import { formatApexAgentQuote } from '../src/apexAgentQuote.ts';
import { findTrigger, menuItems } from '../src/composerMenu.ts';
import { mentionFor } from '../src/slug.ts';
import { parseComposer } from '../src/commands.ts';

const require = createRequire(import.meta.url);
const { transform } = require('sucrase');
const source = fs.readFileSync(new URL('../src/ApexAgentAll.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
const textOf = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.type === MarkdownStub ? node.props.text : node?.children?.map(textOf).join('') ?? '';
const find = (node, predicate) => !node || typeof node !== 'object' ? null : predicate(node) ? node : node.children?.map(child => find(child, predicate)).find(Boolean) ?? null;
const evidence = { sourceId: 'file:test-report.md', label: 'test-report.md', observedAt: 1, excerpt: 'Login tests failed.' };
const message = (id, role, at) => ({ id, role, at, text: `Message ${id}`, evidence: [evidence] });
const monitor = (workspaceId, messages = [], extras = {}) => ({ workspaceId, messages, findings: [], paused: false, ...extras });
const projects = [{ id: 'mobile', name: 'Mobile launch' }, { id: 'billing', name: 'Billing API' }];

// Stands in for the panels component: the harness only checks which panel was asked for.
const MarkdownStub = () => null;
const PersonalPanelsStub = (props) => ({ type: PersonalPanelsStub, props, children: [] });
const PersonalCallStub = (props) => ({ type: PersonalCallStub, props, children: [] });
const ApexAgentMessageActionsStub = (props) => ({ type: ApexAgentMessageActionsStub, props, children: [] });
const ApexAgentReplyQuoteStub = (props) => ({ type: ApexAgentReplyQuoteStub, props, children: [] });
const ApexAgentComposerToolsStub = (props) => ({ type: ApexAgentComposerToolsStub, props, children: [] });
globalThis.requestAnimationFrame ??= callback => callback();

function harness(props) {
  const states = [];
  let cursor = 0;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef(initial) { cursor++; return { current: initial }; },
    useMemo(fn) { cursor++; return fn(); },
    useEffect() { cursor++; },
    useCallback(fn) { cursor++; return fn; },
  };
  const component = new Function('React', 'LocalVoiceButton', 'Markdown', ...Object.keys(hooks), 'mergeProjectConversations', 'replyTarget', 'laneMentions', 'mentionedLane', 'mentionsAll', 'withoutLaneMentions', 'PersonalPanels', 'PersonalCall', 'TaskViewContext', 'personalTaskGroup', 'personalTaskKey', 'ApexAgentMessageActions', 'ApexAgentReplyQuote', 'ApexAgentComposerTools', 'findTrigger', 'mentionFor', 'parseComposer', 'formatApexAgentQuote', 'messageStateKey', 'retryMessageText', `${compiled}\nreturn ApexAgentAll;`)(React, () => null, MarkdownStub, ...Object.values(hooks), mergeProjectConversations, replyTarget, laneMentions, mentionedLane, mentionsAll, withoutLaneMentions, PersonalPanelsStub, PersonalCallStub, TaskViewContext, personalTaskGroup, personalTaskKey, ApexAgentMessageActionsStub, ApexAgentReplyQuoteStub, ApexAgentComposerToolsStub, findTrigger, mentionFor, parseComposer, formatApexAgentQuote, messageStateKey, retryMessageText);
  const replies = [], mutations = [];
  const callbacks = { onReply: async (...args) => { replies.push(args); }, onMutate: async (...args) => { mutations.push(args); }, onSetUp() {}, onClose() {} };
  return { props, replies, mutations, render() { cursor = 0; return component({ ...callbacks, ...props }); } };
}

test('a project name inside an ordinary word does not redirect a reply', () => {
  const projects = [{ id: 'ui', name: 'UI' }, { id: 'billing', name: 'Billing API' }];
  assert.equal(replyTarget('Build the revised plan', projects, 'billing'), 'billing');
});

test('an incoming background check cannot redirect an already drafted follow-up', async () => {
  const h = harness({ workspaces: projects, monitors: [monitor('mobile', [message('human-mobile', 'human', 20)]), monitor('billing', [message('billing-old', 'assistant', 10)])] });
  let tree = h.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Defer SSO and draft the revised plan' } });
  tree = h.render();
  assert.match(textOf(tree), /About Mobile launch/);
  h.props.monitors = [h.props.monitors[0], monitor('billing', [message('billing-new', 'assistant', 30)])];
  tree = h.render();
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.replies[0][0], 'mobile');
});

test('the combined conversation retains message and finding evidence', () => {
  const h = harness({ workspaces: projects, monitors: [monitor('mobile', [message('cited', 'assistant', 20)], { findings: [{ id: 'finding', summary: 'Release blocked', reason: 'The login check is failing', confidence: 'observed', evidence: [evidence], status: 'open' }] })] });
  let tree = h.render();
  assert.match(textOf(tree), /test-report\.md/);
  assert.match(textOf(tree), /Login tests failed\./);
});

test('all paused monitors show a paused state in the conversation', () => {
  const h = harness({ workspaces: projects, monitors: [monitor('mobile', [], { paused: true }), monitor('billing', [], { paused: true })] });
  let tree = h.render();
  const status = find(tree, node => node.props?.className === 'apex-agent-head-row apex-agent-head-context');
  assert.match(textOf(status), /paused/i);
});

test('the combined conversation surfaces a failed check', () => {
  const h = harness({ workspaces: projects, monitors: [monitor('mobile', [], { error: 'Provider quota exhausted' })] });
  let tree = h.render();
  assert.doesNotMatch(textOf(tree), /Provider quota exhausted|Last check failed/);
  find(tree, node => node.type === 'button' && node.props.role === 'tab' && /Notifications/.test(textOf(node))).props.onClick();
  assert.match(textOf(h.render()), /Provider quota exhausted|Last check failed/);
});

test('Resolve remains scoped to the project owning its finding', async () => {
  const h = harness({ workspaces: projects, monitors: [monitor('mobile'), monitor('billing', [], { findings: [{ id: 'b-finding', summary: 'Billing blocked', reason: '', evidence: [], status: 'open' }] })] });
  let tree = h.render();
  find(tree, node => node.type === 'button' && node.props.role === 'tab' && /Notifications/.test(textOf(node))).props.onClick();
  tree = h.render();
  find(tree, node => node.type === 'button' && textOf(node) === 'Resolve').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.mutations, [['billing', 'monitor_resolve', { findingId: 'b-finding', status: 'resolved' }]]);
});


test('after Clear, an incoming check cannot redirect a draft with no visible history', async () => {
  const h = harness({ workspaces: projects, monitors: [monitor('mobile', [message('hidden-mobile', 'human', 20)]), monitor('billing', [message('hidden-billing', 'assistant', 10)])], clearedAt: 100 });
  let tree = h.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Draft the revised plan' } });
  tree = h.render();
  assert.match(textOf(tree), /About Mobile launch/);
  h.props.monitors = [h.props.monitors[0], monitor('billing', [message('billing-new', 'assistant', 101)])];
  tree = h.render();
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.replies[0][0], 'mobile');
});

test('a reply completing must preserve a new draft typed while waiting', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const h = harness({ workspaces: projects, monitors: [monitor('mobile', [message('human-mobile', 'human', 20)])], onReply: () => waiting });
  let tree = h.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'First question' } });
  tree = h.render();
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  tree = h.render();
  const input = find(tree, node => node.type === 'textarea');
  assert.ok(!input.props.disabled, 'The composer remains editable while waiting');
  input.props.onChange({ target: { value: 'Next question I do not want erased' } });
  finish();
  await new Promise(resolve => setImmediate(resolve));
  tree = h.render();
  assert.equal(find(tree, node => node.type === 'textarea').props.value, 'Next question I do not want erased');
});

test('Clear hides chat messages but keeps unresolved findings and evidence in Notifications', () => {
  const h = harness({ workspaces: projects, clearedAt: 100, monitors: [monitor('mobile', [message('old', 'assistant', 20)], { findings: [{ id: 'finding', summary: 'Release blocked', reason: 'The login check is failing', confidence: 'observed', evidence: [evidence], status: 'open' }] })] });
  let tree = h.render();
  assert.doesNotMatch(textOf(tree), /Message old/);
  assert.doesNotMatch(textOf(tree), /Release blocked/);
  find(tree, node => node.type === 'button' && node.props.role === 'tab' && /Notifications/.test(textOf(node))).props.onClick();
  tree = h.render();
  assert.match(textOf(tree), /Release blocked/);
  assert.match(textOf(tree), /Login tests failed/);
  assert.match(textOf(tree), /Dismiss/);
});


test('Enter while a reply is pending must keep the next draft unsent', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const calls = [];
  const h = harness({ workspaces: projects, monitors: [monitor('mobile', [message('human-mobile', 'human', 20)])], onReply: (...args) => { calls.push(args); return waiting; } });
  let tree = h.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'First question' } });
  tree = h.render();
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  tree = h.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Second question' } });
  tree = h.render();
  assert.ok(find(tree, node => node.type === 'button' && textOf(node) === 'Sending…').props.disabled);
  find(tree, node => node.type === 'textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {}, currentTarget: { form: { requestSubmit() { find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} }); } } } });
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, 'The disabled Send state must also guard keyboard submission');
  assert.equal(find(h.render(), node => node.type === 'textarea').props.value, 'Second question');
});

test('failed send restores the submitted draft when nothing new was typed', async () => {
  const h = harness({ workspaces: projects, monitors: [monitor('mobile')], onReply: async () => { throw new Error('Request failed'); } });
  let tree = h.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'First question' } });
  tree = h.render();
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  tree = h.render();
  assert.equal(find(tree, node => node.type === 'textarea').props.value, 'First question');
  assert.match(textOf(tree), /Request failed/);
});

test('failed send preserves text typed while waiting', async () => {
  let fail;
  const waiting = new Promise((_, reject) => { fail = reject; });
  const h = harness({ workspaces: projects, monitors: [monitor('mobile')], onReply: () => waiting });
  let tree = h.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'First question' } });
  tree = h.render();
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  tree = h.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Next draft' } });
  fail(new Error('Request failed'));
  await new Promise(resolve => setImmediate(resolve));
  tree = h.render();
  assert.equal(find(tree, node => node.type === 'textarea').props.value, 'Next draft');
});


test('offline and completed projects are never counted as watching', () => {
  const h = harness({ workspaces: projects, offlineWorkspaceIds: ['mobile'], monitors: [monitor('mobile'), monitor('billing', [], { completed: true })] });
  const status = textOf(find(h.render(), node => node.props?.className === 'apex-agent-head-row apex-agent-head-context'));
  assert.match(status, /offline/i); assert.match(status, /complete/i); assert.doesNotMatch(status, /Watching/);
});

test('evidence opens using its exact owning project and source', async () => {
  const opened = [];
  const h = harness({ workspaces: projects, monitors: [monitor('billing', [message('e', 'assistant', 1)])], onOpenEvidence: async (...args) => opened.push(args) });
  const button = find(h.render(), node => node.type === 'button' && textOf(node).includes('test-report.md'));
  assert.ok(button); button.props.onClick(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, [['billing', evidence]]);
});

test('an all-project question reasons globally instead of mutating the last project', async () => {
  const global = [];
  const h = harness({ workspaces: projects, monitors: [monitor('mobile'), monitor('billing')], onOverview: async text => global.push(text) });
  let tree = h.render(); find(tree, node => node.type === 'textarea').props.onChange({ target: { value: "What's blocked everywhere?" } });
  tree = h.render(); find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(global, ["What's blocked everywhere?"]); assert.equal(h.replies.length, 0);
});


test('mentioning two projects uses global reasoning, but overlapping names stay scoped', async () => {
  for (const [text, globalExpected] of [['Compare Mobile launch and Billing API', true], ['How is Mobile launch?', false]]) {
    const global = [];
    const h = harness({ workspaces: [...projects, { id: 'short', name: 'Mobile' }], monitors: [monitor('mobile'), monitor('billing'), monitor('short')], onOverview: async text => global.push(text) });
    let tree = h.render(); find(tree, node => node.type === 'textarea').props.onChange({ target: { value: text } });
    tree = h.render(); find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(global.length, globalExpected ? 1 : 0); assert.equal(h.replies.length, globalExpected ? 0 : 1);
    if (!globalExpected) assert.equal(h.replies[0][0], 'mobile');
  }
});

test('Check now still checks connected active projects when another is paused or offline', async () => {
  const h = harness({ workspaces: projects, offlineWorkspaceIds: ['short'], monitors: [monitor('mobile'), monitor('billing', [], { paused: true }), monitor('short')] });
  const button = find(h.render(), node => node.type === 'button' && textOf(node) === 'Check now');
  assert.equal(button.props.disabled, false); button.props.onClick(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.mutations, [['mobile', 'monitor_check_now', {}]]);
});

test('shared task reply locks its assignment while drafting and preserves a failed draft', async () => {
  const sent = [];
  const first = { id: 'task-1', project: 'Mobile launch', label: 'Parser fix', send: async text => { sent.push(text); throw new Error('Offline task host'); } };
  const h = harness({ workspaces: projects, monitors: [monitor('mobile')], taskContext: first });
  let tree = h.render(); find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Keep this task note' } });
  h.props.taskContext = { id: 'task-2', project: 'Billing API', label: 'Other task', send: async () => assert.fail('draft redirected') };
  tree = h.render(); assert.match(textOf(tree), /Parser fix/);
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(sent, ['Keep this task note']);
  assert.equal(find(h.render(), node => node.type === 'textarea').props.value, 'Keep this task note');
});

test('new message explicitly resets shared task routing without erasing its text', async () => {
  let cleared = 0;
  const h = harness({ workspaces: projects, monitors: [monitor('mobile')], taskContext: { id: 'task-1', project: 'Mobile launch', label: 'Task note', send: async () => assert.fail('task context was reset') }, onClearTaskContext: () => { cleared++; h.props.taskContext = null; } });
  let tree = h.render(); find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Separate message' } }); tree = h.render();
  find(tree, node => node.type === 'button' && textOf(node) === 'New message').props.onClick(); tree = h.render();
  assert.equal(find(tree, node => node.type === 'textarea').props.value, 'Separate message'); assert.equal(cleared, 1);
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(h.replies, [['mobile', 'Separate message']]);
});

// The personal assistant: one more lane in the same conversation, owned by its host.
const operation = { tool: 'host.command', host: 'vps', cwd: '/root/apex-assistant-slice', argv: ['df', '-h', '/'] };
const personalTask = (status, decisionStatus = 'open', kind = 'approve') => ({ id: 'pt-1', goal: 'Report free disk space', completionCriteria: [], targetHost: 'vps', status, operation, decision: { id: 'pd-1', kind, paramsHash: 'sha256:abc', prompt: 'Run `df -h /`?', status: decisionStatus, openedAt: 2 }, receipts: [], updatedAt: 2 });
const personalLane = (tasks = [], messages = [], extras = {}) => {
  const calls = [];
  return { calls, lane: { name: 'Assistant', hostName: 'apex-terminal', offline: false, assistant: { id: 'asst-1', name: 'Assistant', hostId: 'vps', allowedFolders: [operation.cwd], revision: 1, messages, tasks },
    send: async (text) => { calls.push(['send', text]); }, decide: async (...args) => { calls.push(['decide', ...args]); }, cancel: async (id) => { calls.push(['cancel', id]); }, ...extras } };
};
const pm = (id, role, kind, at, text, taskId) => ({ id, role, kind, at, text, ...(taskId ? { taskId } : {}) });
// A task's approval, result and app lines show as one link in the conversation; its details open from that link.
const openFirstTaskLink = (h) => {
  const link = find(h.render(), node => node.props?.className === 'apex-agent-task-link');
  assert.ok(link, 'a task link is shown in the conversation');
  link.props.onClick();
  return h.render();
};
const collectAll = (tree, predicate) => { const found = []; const walk = (node) => { if (node && typeof node === 'object') { if (predicate(node)) found.push(node); node.children?.forEach(walk); } }; walk(tree); return found; };

test('with no watched project, a message goes to the personal assistant', async () => {
  const { calls, lane } = personalLane();
  const h = harness({ workspaces: projects, monitors: [], personal: lane });
  let tree = h.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'How much disk is free on the server?' } });
  tree = h.render();
  assert.match(textOf(tree), /To Assistant · apex-terminal/);
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['send', 'How much disk is free on the server?']]);
  assert.equal(h.replies.length, 0);
});

test('naming a project still sends to that project when the assistant is present', async () => {
  const { calls, lane } = personalLane([], [pm('pm-1', 'assistant', 'chat', 50, 'Hi')]);
  const h = harness({ workspaces: projects, monitors: [monitor('mobile'), monitor('billing')], personal: lane });
  let tree = h.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Is Billing API ready?' } });
  tree = h.render();
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.replies[0][0], 'billing');
  assert.equal(calls.length, 0);
});

test('composer @mentions route by selected lane id, and @all uses overview routing', async () => {
  const { calls, lane } = personalLane();
  const overviews = [];
  const h = harness({ workspaces: projects, monitors: [monitor('mobile'), monitor('billing')], personal: lane, onOverview: async text => overviews.push(text) });
  let tree = h.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: '@personal check this' } });
  tree = h.render(); find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0][0], 'send');
  assert.equal(calls[0][1], '@personal check this');

  tree = h.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: '@all summarize both projects' } });
  tree = h.render(); find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(overviews, ['@all summarize both projects']);
});

test('naming a project called "All Hands" sends to it, not to every project', async () => {
  // Null's repro: "@all-hands" matched /@all\b/ and took the all-project route.
  const named = [{ id: 'ws-1', name: 'All Hands' }, { id: 'ws-2', name: 'Billing API' }];
  const overviews = [];
  const h = harness({ workspaces: named, monitors: [monitor('ws-1'), monitor('ws-2')], onOverview: async text => overviews.push(text) });
  let tree = h.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: '@all-hands status?' } });
  tree = h.render();
  assert.match(textOf(tree), /About All Hands/, 'the composer says which project it goes to');
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(overviews, [], 'a project handle is not @all');
  assert.equal(h.replies[0][0], 'ws-1');
});

test('@all still asks every project when a project is named beside it', async () => {
  // A project handle only beats the no-context default, never an explicit @all.
  const named = [{ id: 'ws-1', name: 'All Hands' }, { id: 'ws-2', name: 'Billing API' }];
  const overviews = [];
  const h = harness({ workspaces: named, monitors: [monitor('ws-1'), monitor('ws-2')], onOverview: async text => overviews.push(text) });
  let tree = h.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: '@all compare with @billing-api' } });
  tree = h.render();
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(overviews, ['@all compare with @billing-api']);
  assert.equal(h.replies.length, 0, 'not sent to Billing alone');
});

test('a lane @name is read whole, so its words never name other projects or mean every project', async () => {
  // Null's repros: beside projects called "All" and "Hands", "@all-hands" read as naming those two,
  // and "@overall" read as the word "overall"; both went to every project.
  const named = [{ id: 'ws-1', name: 'All Hands' }, { id: 'ws-2', name: 'All' }, { id: 'ws-3', name: 'Hands' }, { id: 'ws-4', name: 'Overall' }, { id: 'ws-5', name: 'Billing API' }];
  const { calls, lane } = personalLane();
  const overviews = [];
  const h = harness({ workspaces: named, monitors: named.map(p => monitor(p.id)), personal: lane, onOverview: async text => overviews.push(text) });
  const send = async (value) => {
    let tree = h.render();
    find(tree, node => node.type === 'textarea').props.onChange({ target: { value } });
    tree = h.render();
    const destination = textOf(find(tree, node => node.props?.className === 'apex-agent-muted apex-agent-all-destination'));
    find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    return destination;
  };
  assert.match(await send('@all-hands status?'), /About All Hands/);
  assert.match(await send('@overall status?'), /About Overall/);
  // The @ menu writes @assistant for the assistant; that is no project named in passing.
  assert.match(await send('@assistant remind me to check Billing API'), /To Assistant/);
  assert.deepEqual(h.replies.map(reply => reply[0]), ['ws-1', 'ws-4']);
  assert.deepEqual(calls, [['send', '@assistant remind me to check Billing API']]);
  assert.deepEqual(overviews, []);
  // Written as plain words, they still mean every project.
  assert.match(await send('how is it going overall?'), /About all projects/);
  assert.match(await send('compare All and Hands'), /About all projects/);
  assert.deepEqual(overviews, ['how is it going overall?', 'compare All and Hands']);
});

test('a project picked from the @ menu is reached by the mention the menu wrote', async () => {
  // Real project ids look like ws-…, never the start of the project's name.
  const named = [{ id: 'ws-1', name: 'Mobile launch' }, { id: 'ws-2', name: 'Billing API' }];
  const h = harness({ workspaces: named, monitors: [monitor('ws-1'), monitor('ws-2')] });
  let tree = h.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: '@billing-api check the totals' } });
  tree = h.render(); find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.replies[0][0], 'ws-2');
});

test('an @mention picks the project it names in full, not one whose name starts the same way', async () => {
  const named = [{ id: 'ws-1', name: 'Mobile' }, { id: 'ws-2', name: 'Mobile launch' }];
  const h = harness({ workspaces: named, monitors: [monitor('ws-1'), monitor('ws-2')] });
  let tree = h.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: '@mobile-launch check the totals' } });
  tree = h.render(); find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.replies[0][0], 'ws-2');
});

test('two projects with one name are offered by their ids, so picking either one reaches it', async () => {
  const twins = [{ id: 'ws-1', name: 'Mobile' }, { id: 'ws-2', name: 'Mobile' }, { id: 'ws-3', name: 'Billing API' }];
  const h = harness({ workspaces: twins, monitors: twins.map(p => monitor(p.id)) });
  let tree = h.render();
  const people = find(tree, node => node.type === ApexAgentComposerToolsStub).props.participants;
  assert.deepEqual(menuItems(findTrigger('@', 1), people, [], [], false, false).map(item => [item.id, item.label]), [['ws-1', '@ws-1'], ['ws-2', '@ws-2'], ['ws-3', '@billing-api']]);
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: '@ws-2 check the totals' } });
  tree = h.render(); find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.replies[0][0], 'ws-2');
});

test('reply quote freezes its lane, clears task context, and survives a failed send', async () => {
  let cleared = 0;
  const attempted = [];
  const h = harness({ workspaces: projects, monitors: [monitor('mobile', [message('quote-mobile', 'assistant', 2)]), monitor('billing', [message('billing-chat', 'assistant', 1)])], taskContext: { id: 'task-1', project: 'Mobile launch', label: 'Task note', send: async () => assert.fail('reply quote should clear task routing') }, onClearTaskContext: () => { cleared++; h.props.taskContext = null; }, onReply: async (id, text) => { attempted.push([id, text]); throw new Error('offline'); } });
  let tree = h.render();
  const mobileArticle = find(tree, node => node.type === 'article' && textOf(node).includes('Mobile launch'));
  find(mobileArticle, node => node.type === ApexAgentMessageActionsStub).props.onReply();
  tree = h.render();
  assert.equal(cleared, 1);
  assert.match(find(tree, node => node.type === ApexAgentReplyQuoteStub).props.quotes[0].text, /Message quote-mobile/);
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Please follow up, Billing API' } });
  tree = h.render(); find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempted[0][0], 'mobile');
  tree = h.render();
  assert.ok(find(tree, node => node.type === ApexAgentReplyQuoteStub).props.quotes.length, 'failed sends keep the quote attached');
  assert.match(textOf(tree), /offline/);
});

test('a second Reply stacks instead of replacing, and sending carries both quotes to the first lane', async () => {
  const h = harness({ workspaces: projects, monitors: [monitor('mobile', [message('m-first', 'assistant', 2)]), monitor('billing', [message('m-second', 'assistant', 3)])] });
  let tree = h.render();
  const actions = () => collectAll(tree, node => node.type === ApexAgentMessageActionsStub).filter(node => typeof node.props.onReply === 'function');
  assert.equal(actions().length, 2);
  actions()[0].props.onReply();
  tree = h.render();
  actions()[1].props.onReply();
  tree = h.render();
  actions()[0].props.onReply();
  tree = h.render();
  const quotes = find(tree, node => node.type === ApexAgentReplyQuoteStub).props.quotes;
  assert.equal(quotes.length, 2, 'repeating Reply on the same message is ignored');
  assert.deepEqual(quotes.map(quote => quote.laneId), ['mobile', 'billing']);
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Follow up on both' } });
  tree = h.render();
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.replies[0][0], 'mobile');
  assert.ok(h.replies[0][1].indexOf('Message m-first') < h.replies[0][1].indexOf('Message m-second'), 'quotes keep stack order');
  tree = h.render();
  assert.equal(find(tree, node => node.type === ApexAgentReplyQuoteStub).props.quotes.length, 0, 'a sent reply clears its quotes');
});

test('an open approval is one link in the conversation; its detail shows the exact command, folder and machine, and Approve sends its hash', async () => {
  const messages = [pm('pm-1', 'human', 'chat', 1, 'Disk?'), pm('pm-2', 'system', 'approval', 2, 'Approval needed: Run `df -h /`?', 'pt-1')];
  const { calls, lane } = personalLane([personalTask('needsYou')], messages);
  const h = harness({ workspaces: projects, monitors: [], personal: lane });
  const chat = h.render();
  assert.equal(find(chat, node => node.type === 'button' && textOf(node) === 'Approve'), null, 'no approval buttons in the conversation');
  assert.match(textOf(chat), /Task · Needs you · Report free disk space ›/);
  const tree = openFirstTaskLink(h);
  const text = textOf(tree);
  assert.match(text, /df -h \//);
  assert.match(text, /\/root\/apex-assistant-slice/);
  assert.match(text, /apex-terminal/);
  assert.match(text, /Needs you/);
  find(tree, node => node.type === 'button' && textOf(node) === 'Approve').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['decide', 'pd-1', 'sha256:abc', true]]);
});

test('a settled or superseded approval has no buttons, and only the newest line asks', () => {
  const messages = [pm('pm-2', 'system', 'approval', 2, 'Approval needed: old', 'pt-1'), pm('pm-3', 'system', 'approval', 3, 'Approval needed: new', 'pt-1')];
  const asking = openFirstTaskLink(harness({ workspaces: projects, monitors: [], personal: personalLane([personalTask('needsYou')], messages).lane }));
  assert.equal(collectAll(asking, node => node.type === 'button' && textOf(node) === 'Approve').length, 1);
  for (const task of [personalTask('done', 'approved'), personalTask('needsYou', 'superseded'), personalTask('cancelled', 'denied')]) {
    const tree = openFirstTaskLink(harness({ workspaces: projects, monitors: [], personal: personalLane([task], messages).lane }));
    assert.equal(find(tree, node => node.type === 'button' && textOf(node) === 'Approve'), null, task.status);
  }
});

test('a result shows its status and output, and app notes are labelled App, not the assistant', () => {
  const messages = [pm('pm-4', 'assistant', 'result', 4, '`df -h /` exited with 0.\n```\n/dev/sda1 75G 20G 55G\n```', 'pt-1'), pm('pm-5', 'system', 'update', 5, 'Approved.', 'pt-1')];
  const h = harness({ workspaces: projects, monitors: [], personal: personalLane([personalTask('done', 'approved')], messages).lane });
  assert.equal(find(h.render(), node => node.type === 'pre'), null, 'the conversation shows no output');
  const tree = openFirstTaskLink(h);
  assert.match(textOf(find(tree, node => node.type === 'pre')), /\/dev\/sda1/);
  assert.match(textOf(tree), /Done/);
  assert.match(textOf(tree), /App · /);
});

test('the menu pauses and resumes the personal assistant, and the header says when it is paused', async () => {
  const { calls, lane } = personalLane([], [pm('pm-1', 'assistant', 'chat', 1, 'Hi')], { pause: async (paused) => { calls.push(['pause', paused]); } });
  let tree = harness({ workspaces: projects, monitors: [], personal: lane }).render();
  assert.doesNotMatch(textOf(tree), /Paused/);
  find(tree, node => node.type === 'button' && textOf(node).startsWith('Pause assistant')).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  const paused = personalLane([], [pm('pm-1', 'assistant', 'chat', 1, 'Hi')], { pause: async (value) => { calls.push(['pause', value]); } }).lane;
  paused.assistant.paused = true;
  tree = harness({ workspaces: projects, monitors: [], personal: paused }).render();
  assert.match(textOf(find(tree, node => node.type === 'header')), /Paused/);
  find(tree, node => node.type === 'button' && textOf(node).startsWith('Resume assistant')).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['pause', true], ['pause', false]]);
});

test('an approved or running task has one Stop task button on its newest line, and a finished one has none', async () => {
  const messages = [pm('pm-2', 'system', 'approval', 2, 'Approval needed: Run `df -h /`?', 'pt-1'), pm('pm-3', 'system', 'update', 3, 'Approved.', 'pt-1')];
  for (const status of ['queued', 'running']) {
    const { calls, lane } = personalLane([personalTask(status, 'approved')], messages);
    const tree = openFirstTaskLink(harness({ workspaces: projects, monitors: [], personal: lane }));
    const stops = [];
    const collect = (node) => { if (node && typeof node === 'object') { if (node.type === 'button' && textOf(node) === 'Stop task') stops.push(node); node.children?.forEach(collect); } };
    collect(tree);
    assert.equal(stops.length, 1, status);
    stops[0].props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [['cancel', 'pt-1']], status);
  }
  for (const status of ['done', 'failed', 'cancelled']) {
    const tree = openFirstTaskLink(harness({ workspaces: projects, monitors: [], personal: personalLane([personalTask(status, 'approved')], messages).lane }));
    assert.equal(find(tree, node => node.type === 'button' && textOf(node) === 'Stop task'), null, status);
  }
});

test('a hand-off card says it is your turn, and "I did it" approves its hash', async () => {
  const task = { id: 'ho-1', goal: 'Export the report', completionCriteria: [], targetHost: 'vps', status: 'needsYou', class: 'write', kind: 'command', operation, decision: { id: 'hd-1', kind: 'handOff', paramsHash: 'sha256:ho', prompt: '', status: 'open', openedAt: 2 }, receipts: [], updatedAt: 2 };
  const { calls, lane } = personalLane([task], [pm('ho-m1', 'system', 'approval', 2, 'Hand-off: export the report', 'ho-1')]);
  const tree = openFirstTaskLink(harness({ workspaces: projects, monitors: [], personal: lane }));
  assert.match(textOf(tree), /Your turn: run this yourself, then tell me\./);
  find(tree, node => node.type === 'button' && textOf(node) === 'I did it').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['decide', 'hd-1', 'sha256:ho', true]]);
});

test('a proposed schedule shows a confirmation card that decides with its hash', async () => {
  const { calls, lane } = personalLane();
  lane.assistant.schedules = [{ id: 'sc-1', goal: 'Check disk every morning', argv: ['df', '-h', '/'], dailyAt: '08:00', status: 'proposed', createdAt: 1, runs: 0, paramsHash: 'sha256:sc', decision: { id: 'sd-1', kind: 'schedule', paramsHash: 'sha256:sc', prompt: '', status: 'open', openedAt: 2 } }];
  const h = harness({ workspaces: projects, monitors: [], personal: lane });
  let tree = h.render();
  find(tree, node => node.type === 'button' && node.props.role === 'tab' && /Notifications/.test(textOf(node))).props.onClick();
  tree = h.render();
  assert.match(textOf(tree), /Daily at 08:00/);
  find(tree, node => node.type === 'button' && textOf(node) === 'Confirm schedule').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['decide', 'sd-1', 'sha256:sc', true]]);
});

test('Notifications owns approvals, proposed schedules and delivered notices; opening it marks personal notices seen', async () => {
  const seen = [];
  const { lane } = personalLane([personalTask('needsYou')], [pm('pm-1', 'assistant', 'chat', 5, 'What do you need?')], { seeNotices: async () => seen.push('seen') });
  lane.assistant.notices = [{ id: 'notice-1', text: 'Disk check completed.', urgent: false, at: 7, deliverAt: 7, deliveredAt: 7, fingerprint: 'disk' }];
  lane.assistant.schedules = [{ id: 'schedule-1', goal: 'Check disk every morning', argv: ['df', '-h', '/'], dailyAt: '08:00', status: 'proposed', createdAt: 1, runs: 0, paramsHash: 'sha256:schedule', decision: { id: 'schedule-decision', kind: 'schedule', paramsHash: 'sha256:schedule', prompt: '', status: 'open', openedAt: 2 } }];
  const h = harness({ workspaces: projects, monitors: [], personal: lane });
  let tree = h.render();
  assert.doesNotMatch(textOf(tree), /Confirm schedule|Approve|Disk check completed/);
  find(tree, node => node.type === 'button' && node.props.role === 'tab' && /Notifications/.test(textOf(node))).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = h.render();
  assert.deepEqual(seen, ['seen']);
  assert.match(textOf(tree), /Confirm schedule/);
  assert.match(textOf(tree), /Approve/);
  assert.match(textOf(tree), /Disk check completed/);
  assert.match(textOf(tree), /Notifications · 2/);
  assert.match(find(tree, node => node.type === 'article' && /Disk check completed/.test(textOf(node))).props.className, /is-seen/);
});

test('an approval with a repeat plan lists how often it runs and when it stops', () => {
  const task = { ...personalTask('needsYou'), operation: { ...operation, plan: { everyMs: 600000, maxRuns: 4, until: { outputContains: 'OK' } } } };
  const { lane } = personalLane([task], [pm('pl-1', 'system', 'approval', 2, 'Approval needed', 'pt-1')]);
  const tree = openFirstTaskLink(harness({ workspaces: projects, monitors: [], personal: lane }));
  assert.match(textOf(tree), /every 10 min, up to 4 runs/);
  assert.match(textOf(tree), /output contains “OK”/);
});

test('the menu opens the Memory panel over the transcript', () => {
  const { lane } = personalLane([], [pm('pm-1', 'assistant', 'chat', 1, 'Hi')]);
  const h = harness({ workspaces: projects, monitors: [], personal: lane });
  let tree = h.render();
  assert.equal(find(tree, node => node.type === PersonalPanelsStub), null);
  find(tree, node => node.type === 'button' && node.props.role === 'menuitem' && textOf(node) === 'Memory').props.onClick();
  tree = h.render();
  const panel = find(tree, node => node.type === PersonalPanelsStub);
  assert.equal(panel.props.initial, 'memory');
  assert.equal(panel.props.lane, lane);
});

test('a task is one link where it started in the conversation, while its chat lines stay as ordinary messages', () => {
  const messages = [pm('pm-1', 'human', 'chat', 1, 'Disk?'), pm('pm-2', 'system', 'approval', 2, 'Approval needed', 'pt-1'), pm('pm-3', 'system', 'update', 3, 'Approved.', 'pt-1'), pm('pm-4', 'human', 'chat', 4, 'Thanks'), pm('pm-5', 'assistant', 'result', 5, '`df -h /` exited with 0.\n```\n55G free\n```', 'pt-1')];
  const h = harness({ workspaces: projects, monitors: [], personal: personalLane([personalTask('done', 'approved')], messages).lane });
  const chat = h.render();
  const links = collectAll(chat, node => node.props?.className === 'apex-agent-task-link');
  assert.equal(links.length, 1);
  assert.equal(collectAll(chat, node => node.type === 'article' && /apex-agent-task-card/.test(node.props.className ?? '')).length, 0, 'no card in the conversation');
  assert.match(textOf(links[0]), /Result ready · Report free disk space ›/);
  const text = textOf(chat);
  assert.ok(text.indexOf('Report free disk space') < text.indexOf('Thanks'), 'the link sits where the task started');
  assert.match(text, /Thanks/);
  assert.doesNotMatch(text, /55G free/, 'the result output is in the task, not the conversation');
  const detail = openFirstTaskLink(h);
  const cards = collectAll(detail, node => node.type === 'article' && /apex-agent-task-card/.test(node.props.className ?? ''));
  assert.equal(cards.length, 1);
  assert.equal(collectAll(detail, node => node.type === 'span' && /apex-agent-task-chip/.test(node.props.className ?? '')).length, 1);
  assert.match(textOf(find(cards[0], node => node.type === 'h3')), /Report free disk space/);
  assert.match(textOf(find(cards[0], node => node.type === 'div' && /apex-agent-task-history/.test(node.props.className ?? ''))), /Approved\.[\s\S]*55G free/);
});

test('a personal task renders as one short link in chat; clicking it switches to Tasks with that task open', () => {
  const messages = [pm('pm-2', 'system', 'approval', 2, 'Approval needed', 'pt-1')];
  const h = harness({ workspaces: projects, monitors: [], personal: personalLane([personalTask('needsYou')], messages).lane });
  const chat = h.render();
  const link = find(chat, node => node.props?.className === 'apex-agent-task-link');
  assert.equal(link.type, 'button');
  assert.equal(link.props.role, undefined);
  assert.equal(find(chat, node => node.type === 'article' && /apex-agent-task-card/.test(node.props.className ?? '')), null);
  link.props.onClick();
  const tasks = h.render();
  assert.equal(find(tasks, node => node.type === 'button' && node.props['aria-selected'] === true && /Tasks/.test(textOf(node)))?.type, 'button');
  assert.match(textOf(find(tasks, node => node.type === 'button' && node.props.className === 'apex-agent-back')), /Tasks/);
  assert.match(textOf(find(tasks, node => node.type === 'article')), /Report free disk space/);
});

test('Tasks groups rows into Needs you, Active and Finished; the hidden composer keeps its draft', () => {
  const messages = [pm('pm-1', 'human', 'chat', 1, 'Disk?')];
  const tasks = [personalTask('needsYou'), { ...personalTask('running', 'approved'), id: 'pt-2', goal: 'Watch the queue' }, { ...personalTask('done', 'approved'), id: 'pt-3', goal: 'Check uptime' }];
  const h = harness({ workspaces: projects, monitors: [], personal: personalLane(tasks, messages).lane });
  let tree = h.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Keep this draft' } });
  tree = h.render();
  assert.match(textOf(tree), /To Assistant · apex-terminal/);
  find(tree, node => node.type === 'button' && node.props['aria-selected'] === false && /Tasks/.test(textOf(node))).props.onClick();
  tree = h.render();
  const headings = collectAll(tree, node => node.type === 'h2').map(textOf);
  assert.deepEqual(headings, ['Needs you', 'Active', 'Finished']);
  assert.equal(find(tree, node => node.type === 'form')?.props.hidden, true, 'no composer shown in Tasks');
  assert.equal(find(tree, node => node.type === 'textarea').props.value, 'Keep this draft', 'the hidden composer retains its draft');
  assert.match(textOf(tree), /Tasks · 1/);
  find(tree, node => node.type === 'button' && node.props.role === 'tab' && /^Chat/.test(textOf(node))).props.onClick();
  tree = h.render();
  assert.equal(find(tree, node => node.type === 'textarea').props.value, 'Keep this draft');
  assert.match(textOf(tree), /To Assistant · apex-terminal/);
});

test('Tasks home lists personal rows with place, worker and result; an empty filter says so', () => {
  const h = harness({ workspaces: projects, monitors: [], personal: personalLane([{ ...personalTask('done', 'approved'), kind: 'helper' }], [pm('pm-1', 'assistant', 'result', 2, 'Found it.', 'pt-1')]).lane });
  h.render();
  const tabs = () => find(h.render(), node => node.type === 'button' && node.props.role === 'tab' && /Tasks/.test(textOf(node)));
  tabs().props.onClick();
  const row = find(h.render(), node => node.props?.className === 'apex-agent-task-row');
  assert.match(textOf(row), /Report free disk space/);
  assert.match(textOf(row), /apex-terminal · Helper/);
  assert.match(textOf(row), /Found it\./);
  assert.match(textOf(row), /Result ready/);
  assert.doesNotMatch(textOf(h.render()), /No tasks yet/);
});

test('a project task component reports rows by store; the same id on two hosts gives two rows', () => {
  const h = harness({ workspaces: projects, monitors: [] });
  const provider = () => find(h.render(), node => node.type === TaskViewContext.Provider);
  const row = (hostId, id) => ({ key: `project:${hostId}:mobile:${id}`, source: 'project', hostId, workspaceId: 'mobile', id, title: `Task ${id} on ${hostId}`, place: 'apex-deck', worker: 'Null', status: 'running', statusLabel: 'Running', group: 'active', result: '', updatedAt: 5 });
  // A fake project task component: it reports its rows through the context, as ApexAgentTasks does.
  provider().props.value.report('project:mac:mobile', [row('mac', 'same')]);
  provider().props.value.report('project:vps:mobile', [row('vps', 'same')]);
  assert.equal(provider().props.value.display, 'links');
  find(h.render(), node => node.type === 'button' && node.props.role === 'tab' && /Tasks/.test(textOf(node))).props.onClick();
  const rows = collectAll(h.render(), node => node.props?.className === 'apex-agent-task-row');
  assert.equal(rows.length, 2);
  const texts = rows.map(textOf);
  assert.ok(texts.some(text => /on mac/.test(text)) && texts.some(text => /on vps/.test(text)), 'one row per host');
  // Reporting the same rows again must not change anything, so a store reporting every render cannot loop.
  provider().props.value.report('project:mac:mobile', [row('mac', 'same')]);
  assert.equal(collectAll(h.render(), node => node.props?.className === 'apex-agent-task-row').length, 2);
});

test('project approvals appear in Notifications and open their exact row in Tasks', () => {
  const h = harness({ workspaces: projects, monitors: [monitor('mobile')] });
  const row = { key: 'project:mac:mobile:approval', source: 'project', hostId: 'mac', workspaceId: 'mobile', id: 'approval', title: 'Review database migration', place: 'apex-deck', worker: 'Null', status: 'needsYou', statusLabel: 'Needs you', group: 'needsYou', result: '', updatedAt: 5 };
  const provider = find(h.render(), node => node.type === TaskViewContext.Provider);
  provider.props.value.report('project:mac:mobile', [row]);
  let tree = h.render();
  find(tree, node => node.type === 'button' && node.props.role === 'tab' && /Notifications/.test(textOf(node))).props.onClick();
  tree = h.render();
  assert.match(textOf(tree), /Review database migration/);
  find(tree, node => node.type === 'button' && textOf(node) === 'Review in Tasks ›').props.onClick();
  tree = h.render();
  assert.equal(find(tree, node => node.type === 'button' && node.props.role === 'tab' && /Tasks · 1/.test(textOf(node))).props['aria-selected'], true);
  assert.match(textOf(find(tree, node => node.props?.className === 'apex-agent-task-bar')), /Review database migration/);
});

test('the place filter only changes the list, never the composer destination', () => {
  const messages = [pm('pm-1', 'human', 'chat', 1, 'Disk?')];
  const h = harness({ workspaces: projects, monitors: [], personal: personalLane([personalTask('needsYou')], messages).lane });
  let tree = h.render();
  find(tree, node => node.type === 'button' && node.props.role === 'tab' && /Tasks/.test(textOf(node))).props.onClick();
  tree = h.render();
  find(tree, node => node.type === 'button' && node.props.className === 'apex-agent-chip-filter' && textOf(node) === 'apex-terminal').props.onClick();
  tree = h.render();
  assert.equal(collectAll(tree, node => node.props?.className === 'apex-agent-task-row').length, 1);
  find(tree, node => node.type === 'button' && node.props.role === 'tab' && /^Chat/.test(textOf(node))).props.onClick();
  tree = h.render();
  assert.match(textOf(tree), /To Assistant · apex-terminal/);
});

test('the place filter shows an honest empty state for a place with no tasks', () => {
  const h = harness({ workspaces: projects, monitors: [], personal: personalLane([], [pm('pm-1', 'assistant', 'chat', 1, 'Hi')]).lane });
  let tree = h.render();
  find(tree, node => node.type === 'button' && node.props.role === 'tab' && /Tasks/.test(textOf(node))).props.onClick();
  assert.match(textOf(h.render()), /No tasks yet\. Ask ApexAgent/);
});

test('Escape closes a detail to the list, then the list to the conversation, and stops there', () => {
  const messages = [pm('pm-2', 'system', 'approval', 2, 'Approval needed', 'pt-1')];
  const h = harness({ workspaces: projects, monitors: [], personal: personalLane([personalTask('needsYou')], messages).lane });
  const escape = (tree) => { const event = { key: 'Escape', stopped: false, stopPropagation() { this.stopped = true; } }; find(tree, node => node.props?.role === 'region').props.onKeyDown(event); return event; };
  openFirstTaskLink(h);
  let event = escape(h.render());
  assert.equal(event.stopped, true);
  let tree = h.render();
  assert.equal(find(tree, node => node.props?.className === 'apex-agent-task-bar'), null, 'back to the list');
  assert.ok(find(tree, node => node.props?.className === 'apex-agent-task-row'));
  event = escape(tree);
  assert.equal(event.stopped, true);
  tree = h.render();
  assert.equal(find(tree, node => node.props?.className === 'apex-agent-task-row'), null, 'back to the conversation');
  assert.ok(find(tree, node => node.type === 'textarea'));
  const window = escape(tree);
  assert.equal(window.stopped, false, 'Escape in the conversation is left to close the window');
});

test('a task that is in no reported store says it is no longer available', () => {
  const h = harness({ workspaces: projects, monitors: [] });
  const tree = h.render();
  find(tree, node => node.type === 'button' && node.props.role === 'tab' && /Tasks/.test(textOf(node))).props.onClick();
  h.render();
  const provider = find(h.render(), node => node.type === TaskViewContext.Provider);
  provider.props.value.openTask('project:gone:mobile:x');
  assert.match(textOf(h.render()), /This task is no longer available\./);
});


test('filtering to one project shows only its messages, findings and task cards, and Show all clears it', () => {
  let cleared = 0;
  const monitors = [
    monitor('mobile', [message('m1', 'assistant', 10)], { findings: [{ id: 'mf', summary: 'Mobile finding', reason: '', evidence: [], status: 'open' }] }),
    monitor('billing', [message('b1', 'assistant', 20)], { findings: [{ id: 'bf', summary: 'Billing finding', reason: '', evidence: [], status: 'open' }] }),
  ];
  const taskNodes = [{ workspaceId: 'mobile', node: 'Mobile task card' }, { workspaceId: 'billing', node: 'Billing task card' }];
  const all = harness({ workspaces: projects, monitors, taskNodes });
  let everythingTree = all.render();
  const everything = textOf(everythingTree);
  assert.match(everything, /Message m1/); assert.match(everything, /Message b1/); assert.match(everything, /Mobile task card/); assert.match(everything, /Billing task card/);
  assert.doesNotMatch(everything, /Mobile finding|Billing finding/);
  find(everythingTree, node => node.type === 'button' && node.props.role === 'tab' && /Notifications/.test(textOf(node))).props.onClick();
  everythingTree = all.render();
  assert.match(textOf(everythingTree), /Mobile finding/); assert.match(textOf(everythingTree), /Billing finding/);
  assert.doesNotMatch(everything, /Showing/);

  const h = harness({ workspaces: projects, monitors, taskNodes, filterWorkspaceId: 'billing', onClearFilter: () => { cleared++; } });
  let tree = h.render();
  const text = textOf(tree);
  assert.match(text, /Showing Billing API only/);
  assert.match(text, /Message b1/); assert.doesNotMatch(text, /Message m1/);
  assert.doesNotMatch(text, /Billing finding|Mobile finding/);
  assert.match(text, /Billing task card/); assert.doesNotMatch(text, /Mobile task card/);
  find(tree, node => node.type === 'button' && node.props.role === 'tab' && /Notifications/.test(textOf(node))).props.onClick();
  tree = h.render();
  assert.match(textOf(tree), /Billing finding/); assert.doesNotMatch(textOf(tree), /Mobile finding/);
  find(tree, node => node.type === 'button' && textOf(node) === 'Show all').props.onClick();
  assert.equal(cleared, 1);
});

test('while filtering, the personal assistant lane is hidden and the composer defaults to the filtered project', async () => {
  const { lane } = personalLane([], [pm('pm-1', 'assistant', 'chat', 50, 'Personal hello')]);
  const h = harness({ workspaces: projects, monitors: [monitor('mobile', [message('m1', 'assistant', 10)]), monitor('billing', [message('b1', 'assistant', 20)])], personal: lane, filterWorkspaceId: 'billing' });
  let tree = h.render();
  assert.doesNotMatch(textOf(tree), /Personal hello/);
  assert.match(textOf(tree), /About Billing API/);
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Any blockers?' } }); tree = h.render();
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.replies[0][0], 'billing');
});

test('a project tag inside a filtered view changes the reply focus but not the filter', () => {
  let cleared = 0;
  const h = harness({ workspaces: projects, monitors: [monitor('billing', [message('b1', 'assistant', 20)])], filterWorkspaceId: 'billing', onClearFilter: () => { cleared++; } });
  const tree = h.render();
  find(tree, node => node.type === 'button' && node.props.className === 'apex-agent-project-tag').props.onClick();
  assert.equal(cleared, 0);
  assert.match(textOf(h.render()), /Showing Billing API only/);
});

test('the ⋯ menu names a watched project as Sources · name and offers Watch for the rest', () => {
  const h = harness({ workspaces: projects, monitors: [monitor('mobile')], onSetUp: () => {} });
  const text = textOf(h.render());
  assert.match(text, /Sources · Mobile launch/);
  assert.match(text, /Watch Billing API…/);
  assert.doesNotMatch(text, /Sources for/);
});

test('Revert rejects a different project while attachments lock the draft destination', async () => {
  for (const attachmentState of [
    { paths: ['/billing/report.md'], pending: false, hasErrors: false },
    { paths: [], pending: true, hasErrors: false },
    { paths: [], pending: false, hasErrors: true },
  ]) {
    const h = harness({ workspaces: projects, monitors: [monitor('mobile', [message('mobile-human', 'human', 10)]), monitor('billing', [message('billing-human', 'human', 20)])] });
    let tree = h.render();
    find(tree, node => node.type === ApexAgentComposerToolsStub).props.onAttachmentState(attachmentState);
    tree = h.render();
    find(tree, node => node.type === ApexAgentMessageActionsStub && node.props.text === 'Message mobile-human').props.onRevert();
    tree = h.render();
    assert.equal(find(tree, node => node.type === 'textarea').props.value, '', 'The conflicting message must not enter the Billing draft');
    assert.match(textOf(find(tree, node => node.props?.role === 'alert')), /Remove.*attachments.*reverting/i);
    assert.match(textOf(tree), /About Billing API.*fixed for this reply/);
    find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.replies.length, 0);

    find(tree, node => node.type === ApexAgentComposerToolsStub).props.onAttachmentState({ paths: [], pending: false, hasErrors: false });
    tree = h.render();
    find(tree, node => node.type === ApexAgentMessageActionsStub && node.props.text === 'Message mobile-human').props.onRevert();
    tree = h.render();
    assert.equal(find(tree, node => node.type === 'textarea').props.value, 'Message mobile-human');
    find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.replies[0][0], 'mobile');
  }
});

test('a rejected Revert preserves the current draft and same-project Revert keeps attachments', () => {
  const h = harness({ workspaces: projects, monitors: [monitor('mobile', [message('mobile-human', 'human', 10)]), monitor('billing', [message('billing-human', 'human', 20)])] });
  let tree = h.render();
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Message billing-human' } });
  tree = h.render();
  find(tree, node => node.type === ApexAgentComposerToolsStub).props.onAttachmentState({ paths: ['/billing/report.md'], pending: false, hasErrors: false });
  tree = h.render();
  find(tree, node => node.type === ApexAgentMessageActionsStub && node.props.text === 'Message mobile-human').props.onRevert();
  tree = h.render();
  assert.equal(find(tree, node => node.type === 'textarea').props.value, 'Message billing-human');
  find(tree, node => node.type === ApexAgentMessageActionsStub && node.props.text === 'Message billing-human').props.onRevert();
  tree = h.render();
  assert.equal(find(tree, node => node.type === 'textarea').props.value, 'Message billing-human');
  assert.match(textOf(tree), /About Billing API.*fixed for this reply.*1 attachment/);
  assert.equal(find(tree, node => node.props?.role === 'alert'), null);
});

test('personal Retry uses personal host lane and Revert restores its draft', async () => {
  const { lane, calls } = personalLane([], [pm('h1', 'human', 'chat', 10, 'Personal question'), pm('a1', 'assistant', 'chat', 11, 'Personal answer')]);
  const h = harness({ workspaces: projects, monitors: [], personal: lane });
  let tree = h.render();
  await find(tree, node => node.type === ApexAgentMessageActionsStub && node.props.onRetry).props.onRetry();
  assert.equal(calls[0][0], 'send'); assert.ok(calls[0][1].includes('Personal answer'));
  find(tree, node => node.type === ApexAgentMessageActionsStub && node.props.onRevert).props.onRevert();
  tree = h.render(); assert.equal(find(tree, node => node.type === 'textarea').props.value, 'Personal question');
});

test('Retry on a cross-project answer uses the overview route', async () => {
  const calls = [];
  const h = harness({ workspaces: projects, monitors: [], onOverview: async text => calls.push(text), overviewEntries: [{ workspaceId: '*', project: 'All projects', message: message('overview', 'assistant', 10) }] });
  await find(h.render(), node => node.type === ApexAgentMessageActionsStub && node.props.onRetry).props.onRetry();
  assert.equal(calls.length, 1); assert.equal(h.replies.length, 0);
});
