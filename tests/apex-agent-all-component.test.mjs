import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { mergeProjectConversations, replyTarget } from '../src/apexAgentModel.ts';

const require = createRequire(import.meta.url);
const { transform } = require('sucrase');
const source = fs.readFileSync(new URL('../src/ApexAgentAll.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
const textOf = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(textOf).join('') ?? '';
const find = (node, predicate) => !node || typeof node !== 'object' ? null : predicate(node) ? node : node.children?.map(child => find(child, predicate)).find(Boolean) ?? null;
const evidence = { sourceId: 'file:test-report.md', label: 'test-report.md', observedAt: 1, excerpt: 'Login tests failed.' };
const message = (id, role, at) => ({ id, role, at, text: `Message ${id}`, evidence: [evidence] });
const monitor = (workspaceId, messages = [], extras = {}) => ({ workspaceId, messages, findings: [], paused: false, ...extras });
const projects = [{ id: 'mobile', name: 'Mobile launch' }, { id: 'billing', name: 'Billing API' }];

// Stands in for the panels component: the harness only checks which panel was asked for.
const PersonalPanelsStub = (props) => ({ type: PersonalPanelsStub, props, children: [] });
const PersonalCallStub = (props) => ({ type: PersonalCallStub, props, children: [] });

function harness(props) {
  const states = [];
  let cursor = 0;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef(initial) { cursor++; return { current: initial }; },
    useMemo(fn) { cursor++; return fn(); },
    useEffect() { cursor++; },
  };
  const component = new Function('React', ...Object.keys(hooks), 'mergeProjectConversations', 'replyTarget', 'PersonalPanels', 'PersonalCall', `${compiled}\nreturn ApexAgentAll;`)(React, ...Object.values(hooks), mergeProjectConversations, replyTarget, PersonalPanelsStub, PersonalCallStub);
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
  const tree = h.render();
  assert.match(textOf(tree), /test-report\.md/);
  assert.match(textOf(tree), /Login tests failed\./);
});

test('all paused monitors show a paused state in the conversation', () => {
  const h = harness({ workspaces: projects, monitors: [monitor('mobile', [], { paused: true }), monitor('billing', [], { paused: true })] });
  const tree = h.render();
  const status = find(tree, node => node.props?.className === 'apex-agent-head-row apex-agent-head-context');
  assert.match(textOf(status), /paused/i);
});

test('the combined conversation surfaces a failed check', () => {
  const h = harness({ workspaces: projects, monitors: [monitor('mobile', [], { error: 'Provider quota exhausted' })] });
  assert.match(textOf(h.render()), /Provider quota exhausted|Last check failed/);
});

test('Resolve remains scoped to the project owning its finding', async () => {
  const h = harness({ workspaces: projects, monitors: [monitor('mobile'), monitor('billing', [], { findings: [{ id: 'b-finding', summary: 'Billing blocked', reason: '', evidence: [], status: 'open' }] })] });
  const tree = h.render();
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

test('Clear hides chat messages but keeps unresolved findings and evidence', () => {
  const h = harness({ workspaces: projects, clearedAt: 100, monitors: [monitor('mobile', [message('old', 'assistant', 20)], { findings: [{ id: 'finding', summary: 'Release blocked', reason: 'The login check is failing', confidence: 'observed', evidence: [evidence], status: 'open' }] })] });
  const tree = h.render();
  assert.doesNotMatch(textOf(tree), /Message old/);
  assert.match(textOf(tree), /Release blocked/);
  assert.match(textOf(tree), /Login tests failed/);
  assert.match(textOf(tree), /Resolve/);
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

test('an open approval shows the exact command, folder and machine, and Approve sends its hash', async () => {
  const messages = [pm('pm-1', 'human', 'chat', 1, 'Disk?'), pm('pm-2', 'system', 'approval', 2, 'Approval needed: Run `df -h /`?', 'pt-1')];
  const { calls, lane } = personalLane([personalTask('needsYou')], messages);
  const h = harness({ workspaces: projects, monitors: [], personal: lane });
  const tree = h.render();
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
  const asking = harness({ workspaces: projects, monitors: [], personal: personalLane([personalTask('needsYou')], messages).lane }).render();
  const buttons = [];
  const collect = (node) => { if (node && typeof node === 'object') { if (node.type === 'button' && textOf(node) === 'Approve') buttons.push(node); node.children?.forEach(collect); } };
  collect(asking);
  assert.equal(buttons.length, 1);
  for (const task of [personalTask('done', 'approved'), personalTask('needsYou', 'superseded'), personalTask('cancelled', 'denied')]) {
    const tree = harness({ workspaces: projects, monitors: [], personal: personalLane([task], messages).lane }).render();
    assert.equal(find(tree, node => node.type === 'button' && textOf(node) === 'Approve'), null, task.status);
  }
});

test('a result shows its status and output, and app notes are labelled App, not the assistant', () => {
  const messages = [pm('pm-4', 'assistant', 'result', 4, '`df -h /` exited with 0.\n```\n/dev/sda1 75G 20G 55G\n```', 'pt-1'), pm('pm-5', 'system', 'update', 5, 'Approved.', 'pt-1')];
  const tree = harness({ workspaces: projects, monitors: [], personal: personalLane([personalTask('done', 'approved')], messages).lane }).render();
  assert.match(textOf(find(tree, node => node.type === 'pre')), /\/dev\/sda1/);
  assert.match(textOf(tree), /Done/);
  assert.match(textOf(tree), /App · /);
});

test('the menu pauses and resumes the personal assistant, and the header says when it is paused', async () => {
  const { calls, lane } = personalLane([], [pm('pm-1', 'assistant', 'chat', 1, 'Hi')], { pause: async (paused) => { calls.push(['pause', paused]); } });
  let tree = harness({ workspaces: projects, monitors: [], personal: lane }).render();
  assert.doesNotMatch(textOf(tree), /Paused/);
  find(tree, node => node.type === 'button' && textOf(node) === 'Pause assistant').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  const paused = personalLane([], [pm('pm-1', 'assistant', 'chat', 1, 'Hi')], { pause: async (value) => { calls.push(['pause', value]); } }).lane;
  paused.assistant.paused = true;
  tree = harness({ workspaces: projects, monitors: [], personal: paused }).render();
  assert.match(textOf(find(tree, node => node.type === 'header')), /Paused/);
  find(tree, node => node.type === 'button' && textOf(node) === 'Resume assistant').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['pause', true], ['pause', false]]);
});

test('an approved or running task has one Stop task button on its newest line, and a finished one has none', async () => {
  const messages = [pm('pm-2', 'system', 'approval', 2, 'Approval needed: Run `df -h /`?', 'pt-1'), pm('pm-3', 'system', 'update', 3, 'Approved.', 'pt-1')];
  for (const status of ['queued', 'running']) {
    const { calls, lane } = personalLane([personalTask(status, 'approved')], messages);
    const tree = harness({ workspaces: projects, monitors: [], personal: lane }).render();
    const stops = [];
    const collect = (node) => { if (node && typeof node === 'object') { if (node.type === 'button' && textOf(node) === 'Stop task') stops.push(node); node.children?.forEach(collect); } };
    collect(tree);
    assert.equal(stops.length, 1, status);
    stops[0].props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [['cancel', 'pt-1']], status);
  }
  for (const status of ['done', 'failed', 'cancelled']) {
    const tree = harness({ workspaces: projects, monitors: [], personal: personalLane([personalTask(status, 'approved')], messages).lane }).render();
    assert.equal(find(tree, node => node.type === 'button' && textOf(node) === 'Stop task'), null, status);
  }
});

test('a hand-off card says it is your turn, and "I did it" approves its hash', async () => {
  const task = { id: 'ho-1', goal: 'Export the report', completionCriteria: [], targetHost: 'vps', status: 'needsYou', class: 'write', kind: 'command', operation, decision: { id: 'hd-1', kind: 'handOff', paramsHash: 'sha256:ho', prompt: '', status: 'open', openedAt: 2 }, receipts: [], updatedAt: 2 };
  const { calls, lane } = personalLane([task], [pm('ho-m1', 'system', 'approval', 2, 'Hand-off: export the report', 'ho-1')]);
  const tree = harness({ workspaces: projects, monitors: [], personal: lane }).render();
  assert.match(textOf(tree), /Your turn: run this yourself, then tell me\./);
  find(tree, node => node.type === 'button' && textOf(node) === 'I did it').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['decide', 'hd-1', 'sha256:ho', true]]);
});

test('a proposed schedule shows a confirmation card that decides with its hash', async () => {
  const { calls, lane } = personalLane();
  lane.assistant.schedules = [{ id: 'sc-1', goal: 'Check disk every morning', argv: ['df', '-h', '/'], dailyAt: '08:00', status: 'proposed', createdAt: 1, runs: 0, paramsHash: 'sha256:sc', decision: { id: 'sd-1', kind: 'schedule', paramsHash: 'sha256:sc', prompt: '', status: 'open', openedAt: 2 } }];
  const tree = harness({ workspaces: projects, monitors: [], personal: lane }).render();
  assert.match(textOf(tree), /Daily at 08:00/);
  find(tree, node => node.type === 'button' && textOf(node) === 'Confirm schedule').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['decide', 'sd-1', 'sha256:sc', true]]);
});

test('an approval with a repeat plan lists how often it runs and when it stops', () => {
  const task = { ...personalTask('needsYou'), operation: { ...operation, plan: { everyMs: 600000, maxRuns: 4, until: { outputContains: 'OK' } } } };
  const { lane } = personalLane([task], [pm('pl-1', 'system', 'approval', 2, 'Approval needed', 'pt-1')]);
  const tree = harness({ workspaces: projects, monitors: [], personal: lane }).render();
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
