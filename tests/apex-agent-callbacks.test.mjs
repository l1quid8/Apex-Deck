import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'sucrase';
import { compatibleMonitorProfiles } from '../src/apexAgentModel.ts';
import { assistantDisplayName } from '../src/assistantName.ts';

// The per-project Sources sheet owns the monitor load, save and assignment callbacks that the dock relies on.
const source = await fs.readFile(new URL('../src/ApexAgentSources.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace('export function ApexAgentSources', 'function ApexAgentSources'), {
  transforms: ['typescript', 'jsx'], jsxRuntime: 'classic',
}).code;

function componentHarness() {
  let states = [], refs = [], effects = [], cursor = 0, mounted = true;
  const intervals = new Set();
  const confirmations = [];
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { if (mounted) states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return refs[i] ??= { current: initial }; },
    useMemo(fn) { cursor++; return fn(); },
    useEffect(fn, deps) { const i = cursor++; const prev = effects[i]; if (!prev || !deps || deps.some((v, j) => !Object.is(v, prev.deps[j]))) effects[i] = { fn, deps, changed: true }; },
  };
  const component = new Function('React', 'useState', 'useRef', 'useMemo', 'useEffect', 'compatibleMonitorProfiles', 'defaultMonitorProfileId', 'parseProjectFiles', 'workspaceHost', 'assistantDisplayName', 'window', `${compiled}; return ApexAgentSources;`)(
    React, hooks.useState, hooks.useRef, hooks.useMemo, hooks.useEffect,
    compatibleMonitorProfiles, (_profiles, stored) => stored ?? 'profile-1',
    text => text.split('\n').map(line => line.trim()).filter(path => path && !path.startsWith('../') && !path.startsWith('/')),
    w => w.hostId ?? 'local',
    assistantDisplayName,
    { confirm: message => { confirmations.push(message); return true; }, localStorage: { getItem: () => null, setItem() {} }, setInterval: fn => { intervals.add(fn); return fn; }, clearInterval: fn => intervals.delete(fn) },
  );
  let props;
  function render(nextProps = props) {
    props = nextProps; cursor = 0;
    const tree = component(props);
    for (const effect of effects) if (effect?.changed) { effect.changed = false; effect.cleanup?.(); effect.cleanup = effect.fn(); }
    return tree;
  }
  function unmount() { mounted = false; for (const effect of effects) effect?.cleanup?.(); intervals.clear(); }
  return { render, unmount, intervals, confirmations };
}

function deferred() { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
const workspace = (id = 'project', hostId = 'host-a', path = '/project') => ({ id, name: id, hostId, path });
const monitor = (name = 'snapshot', owner = {}) => ({
  workspaceId: 'project', conversationId: 'conversation-1', cwd: '/project', hostId: 'host-a', profileId: 'profile-1',
  responsibility: name, nextStep: '', decisions: [], preferences: [], files: [], threads: [], paused: false, completed: false,
  revision: 1, messages: [], findings: [], activity: [], lastCheckedAt: null, nextCheckAt: null, wakeReason: null,
  evidenceFingerprint: null, activeCheck: null, error: null, ...owner,
});
const base = (backend, onMonitorChange = () => {}, extra = {}) => ({ workspace: workspace(), backend, profiles: [], panes: [], onBack() {}, onClose() {}, onMonitorChange, ...extra });
const profile = { id: 'profile-1', display_name: 'Local chat', backend: { kind: 'open_ai_compatible' }, media: null };
const pane = (id, title = id) => ({ id, title, kind: 'chat', workspaceId: 'project', archived: false });
const find = (node, predicate) => { if (!node || typeof node !== 'object') return null; if (Array.isArray(node)) { for (const child of node) { const found = find(child, predicate); if (found) return found; } return null; } if (predicate(node)) return node; for (const child of node.children ?? []) { const found = find(child, predicate); if (found) return found; } return null; };
const findAll = (node, predicate, matches = []) => { if (!node || typeof node !== 'object') return matches; if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, matches); return matches; } if (predicate(node)) matches.push(node); for (const child of node.children ?? []) findAll(child, predicate, matches); return matches; };
const visibleText = node => !node || typeof node !== 'object' ? String(node ?? '') : Array.isArray(node) ? node.map(visibleText).join(' ') : (node.children ?? []).map(visibleText).join(' ');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const saveButton = tree => find(tree, n => n.type === 'button' && n.children?.[0] === 'Save sources');
const removeButton = (tree, file) => find(tree, n => n.type === 'button' && n.props['aria-label'] === `Remove ${file}`);

test('accepted monitor load and save replies call back with owner host and snapshots', async () => {
  const calls = [], changes = [];
  const backend = { host: { id: 'host-a' }, call: async (command, args) => { calls.push([command, args]); return monitor(command === 'monitor_get' ? 'loaded' : 'mutated'); } };
  const h = componentHarness();
  let tree = h.render(base(backend, (...args) => changes.push(args)));
  await tick();
  assert.deepEqual(changes, [['project', 'host-a', monitor('loaded')]]);
  tree = h.render(base(backend, (...args) => changes.push(args)));
  saveButton(tree)?.props.onClick();
  await tick();
  assert.deepEqual(calls.find(([command]) => command === 'monitor_sources_update')?.[1], {
    workspaceId: 'project', cwd: '/project', hostId: 'host-a', conversationId: 'conversation-1', files: [], threads: [], mode: 'replace',
  });
  assert.deepEqual(changes.at(-1), ['project', 'host-a', monitor('mutated')]);
  h.unmount();
});

test('a missing saved monitor reports a null snapshot for the route host', async () => {
  const changes = [], missing = deferred();
  const backend = { host: { id: 'route-host' }, call: () => missing.promise };
  const h = componentHarness(); h.render(base(backend, (...args) => changes.push(args)));
  missing.resolve(null); await tick();
  assert.deepEqual(changes, [['project', 'route-host', null]]);
  h.unmount();
});

test('workspace/host switches and unmount reject stale load replies', async () => {
  const old = deferred(), next = deferred(), changes = [];
  const backendA = { host: { id: 'host-a' }, call: () => old.promise };
  const backendB = { host: { id: 'host-b' }, call: () => next.promise };
  const h = componentHarness();
  h.render(base(backendA, (...args) => changes.push(args)));
  h.render({ ...base(backendB, (...args) => changes.push(args)), workspace: workspace('other', 'host-b') });
  old.resolve(monitor('stale')); next.resolve(monitor('current', { workspaceId: 'other', hostId: 'host-b' })); await tick();
  assert.deepEqual(changes, [['other', 'host-b', monitor('current', { workspaceId: 'other', hostId: 'host-b' })]]);
  const late = deferred(), backendC = { host: { id: 'host-b' }, call: () => late.promise };
  h.render({ ...base(backendC, (...args) => changes.push(args)), workspace: workspace('third', 'host-b') });
  h.unmount(); late.resolve(monitor('after-unmount')); await tick();
  assert.equal(changes.length, 1);
});

test('an older poll cannot replace or callback over a newer save reply', async () => {
  const poll = deferred(), mutation = deferred(), changes = [];
  let getCount = 0;
  const backend = { host: { id: 'host-a' }, call: command => command === 'monitor_get' ? (++getCount === 1 ? Promise.resolve(monitor('initial')) : poll.promise) : mutation.promise };
  const h = componentHarness();
  let tree = h.render(base(backend, (...args) => changes.push(args))); await tick();
  const pollFn = [...h.intervals][0]; pollFn();
  tree = h.render(base(backend, (...args) => changes.push(args)));
  saveButton(tree)?.props.onClick();
  mutation.resolve(monitor('new mutation')); await tick();
  poll.resolve(monitor('old poll')); await tick();
  assert.deepEqual(changes.map(([, , item]) => item.responsibility), ['initial', 'new mutation']);
  h.unmount();
});

test('a lower snapshotVersion poll cannot replace the latest accepted monitor', async () => {
  const stalePoll = deferred(), changes = []; let getCount = 0;
  const backend = { host: { id: 'host-a' }, call: command => command === 'monitor_get'
    ? (++getCount === 1 ? Promise.resolve(monitor('newer', { snapshotVersion: 12 })) : stalePoll.promise)
    : Promise.resolve(monitor('unused')) };
  const h = componentHarness(); const props = base(backend, (...args) => changes.push(args));
  let tree = h.render(props); await tick(); tree = h.render(props);
  [...h.intervals][0]?.();
  stalePoll.resolve(monitor('older', { snapshotVersion: 11 })); await tick();
  tree = h.render(props);
  assert.equal(changes.length, 1);
  assert.equal(find(tree, node => node.type === 'h2')?.children?.[0], 'Sources · project');
  assert.ok(saveButton(tree));
  h.unmount();
});

test('save replies after unmount are ignored', async () => {
  const mutation = deferred(), changes = [];
  const loaded = monitor();
  const backend = { host: { id: 'host-a' }, call: command => command === 'monitor_get' ? Promise.resolve(loaded) : mutation.promise };
  const h = componentHarness();
  let tree = h.render(base(backend, (...args) => changes.push(args))); await tick();
  tree = h.render(base(backend, (...args) => changes.push(args)));
  saveButton(tree)?.props.onClick();
  h.unmount();
  mutation.resolve({ ...loaded, responsibility: 'late save' }); await tick();
  assert.deepEqual(changes, [['project', 'host-a', loaded]]);
});

test('closing the sources sheet does not acknowledge or clear monitor state', async () => {
  const changes = [], blocker = { ...monitor('blocker'), findings: [{ id: 'f', status: 'open', evidence: [] }] };
  const backend = { host: { id: 'host-a' }, call: async () => blocker };
  const h = componentHarness(); let closed = 0;
  const props = base(backend, (...args) => changes.push(args), { onClose: () => { closed++; } });
  let tree = h.render(props); await tick(); tree = h.render(props);
  find(tree, n => n.type === 'button' && n.props['aria-label'] === 'Close Assistant')?.props.onClick();
  assert.equal(closed, 1);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], ['project', 'host-a', blocker]);
  h.unmount();
});

test('workspace path changes invalidate the old load and request the new project folder', async () => {
  const old = deferred(), current = deferred(), changes = [], requests = [];
  const backend = { host: { id: 'host-a' }, call: (command, args) => { requests.push([command, args]); return requests.length === 1 ? old.promise : current.promise; } };
  const h = componentHarness();
  h.render(base(backend, (...args) => changes.push(args)));
  h.render({ ...base(backend, (...args) => changes.push(args)), workspace: workspace('project', 'host-a', '/new-project') });
  old.resolve(monitor('old path')); current.resolve(monitor('new path', { cwd: '/new-project' })); await tick();
  assert.deepEqual(requests, [['monitor_get', { workspaceId: 'project' }], ['monitor_get', { workspaceId: 'project' }]]);
  assert.deepEqual(changes, [['project', 'host-a', monitor('new path', { cwd: '/new-project' })]]);
  h.unmount();
});

test('connection disconnect invalidates pending loads and reconnect starts a fresh load', async () => {
  const old = deferred(), current = deferred(), changes = [], requests = [];
  const listeners = new Set();
  let connectionState = { status: { kind: 'connected' }, revision: 1 };
  const connection = { get: () => connectionState, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  const backend = { host: { id: 'host-a', connection }, call: () => (++requests.length === 1 ? old.promise : current.promise) };
  const h = componentHarness();
  h.render(base(backend, (...args) => changes.push(args)));
  connectionState = { status: { kind: 'reconnecting' }, revision: 1 }; listeners.forEach(listener => listener());
  h.render(base(backend, (...args) => changes.push(args)));
  connectionState = { status: { kind: 'connected' }, revision: 2 }; listeners.forEach(listener => listener());
  h.render(base(backend, (...args) => changes.push(args)));
  old.resolve(monitor('before reconnect')); current.resolve(monitor('after reconnect')); await tick();
  assert.equal(requests.length, 2);
  assert.deepEqual(changes, [['project', 'host-a', monitor('after reconnect')]]);
  h.unmount();
});

test('monitor snapshots for another workspace folder, route host, or workspace are rejected', async () => {
  for (const wrongOwner of [
    { cwd: '/elsewhere' },
    { hostId: 'host-b' },
    { workspaceId: 'other' },
  ]) {
    const changes = [];
    const backend = { host: { id: 'host-a' }, call: async () => monitor('wrong owner', wrongOwner) };
    const h = componentHarness();
    h.render(base(backend, (...args) => changes.push(args)));
    await tick();
    assert.deepEqual(changes, [], `rejected monitor with owner ${JSON.stringify(wrongOwner)}`);
    h.unmount();
  }
});

test('a save reply from a replaced backend on the same route host is ignored', async () => {
  const mutation = deferred(), changes = [];
  const loaded = monitor();
  const backendA = { host: { id: 'host-a' }, call: command => command === 'monitor_get' ? Promise.resolve(loaded) : mutation.promise };
  const backendB = { host: { id: 'host-a' }, call: async () => loaded };
  const h = componentHarness();
  let tree = h.render(base(backendA, (...args) => changes.push(args))); await tick();
  tree = h.render(base(backendA, (...args) => changes.push(args)));
  saveButton(tree)?.props.onClick();
  h.render(base(backendB, (...args) => changes.push(args))); await tick();
  mutation.resolve({ ...loaded, responsibility: 'stale mutation' }); await tick();
  assert.deepEqual(changes, [['project', 'host-a', loaded], ['project', 'host-a', loaded]]);
  h.unmount();
});

test('offline host state makes no monitor request and reports no null callback', async () => {
  const changes = []; let calls = 0;
  const connection = { get: () => ({ status: { kind: 'offline' }, revision: 1 }), subscribe: () => () => {} };
  const backend = { host: { id: 'host-a', connection }, call: async () => { calls++; return null; } };
  const h = componentHarness();
  h.render(base(backend, (...args) => changes.push(args))); await tick();
  assert.equal(calls, 0);
  assert.deepEqual(changes, []);
  h.unmount();
});

test('start watching uses the project name, defaults a compatible profile, and confirms the recent chats', async () => {
  const calls = []; let backed = 0;
  const backend = { host: { id: 'host-a' }, call: async (command, args) => { calls.push([command, args]); return command === 'monitor_get' ? null : monitor('assigned'); } };
  const h = componentHarness();
  const props = base(backend, () => {}, { profiles: [profile], panes: [pane('c1', 'Planning'), pane('c2', 'Review'), pane('c3', 'Notes'), pane('c4', 'Tail')], onBack: () => { backed++; } });
  let tree = h.render(props); await tick(); tree = h.render(props);
  assert.match(visibleText(tree), /Sources · project/);
  assert.match(visibleText(tree), /keep on track in\s+project\s*\?/);
  assert.equal(find(tree, node => node.type === 'select')?.props.value, 'profile-1');
  find(tree, node => node.type === 'textarea')?.props.onChange({ target: { value: 'Keep the repository healthy' } });
  tree = h.render(props);
  find(tree, node => node.type === 'form' && node.props.className === 'apex-agent-sources-start')?.props.onSubmit({ preventDefault() {} });
  await tick();
  assert.equal(calls.some(([command]) => command === 'monitor_suggest_sources'), false, 'the sheet does not suggest files');
  const assignment = calls.find(([command]) => command === 'monitor_assign');
  assert.equal(assignment[1].text, 'Keep the repository healthy');
  assert.equal(assignment[1].profile.id, 'profile-1');
  assert.equal(assignment[1].onlyIfAbsent, true);
  assert.deepEqual(assignment[1].files, []);
  assert.deepEqual(assignment[1].threads, ['c2', 'c3', 'c4']);
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0], /Include 3 recent project chats/);
  assert.equal(backed, 1, 'a successful start returns to the conversation');
  h.unmount();
});

test('unsaved file removals survive stale monitor polls and save the edited selection', async () => {
  const calls = [], changes = [];
  const loaded = monitor('saved', { hostId: 'host-a', files: ['README.md'], threads: ['chat-1'] });
  const backend = { host: { id: 'host-a' }, call: async (command, args) => { calls.push([command, args]); return loaded; } };
  const h = componentHarness(); const props = { ...base(backend, (...args) => changes.push(args)), profiles: [profile], panes: [pane('chat-1'), pane('chat-2')] };
  let tree = h.render(props); await tick(); tree = h.render(props);
  removeButton(tree, 'README.md')?.props.onClick();
  tree = h.render(props);
  [...h.intervals][0]?.();
  await tick(); tree = h.render(props);
  assert.equal(removeButton(tree, 'README.md'), null, 'the stale poll must not restore the locally removed file');
  saveButton(tree)?.props.onClick();
  await tick();
  const save = calls.find(([command]) => command === 'monitor_sources_update');
  assert.deepEqual(save[1].files, []);
  assert.deepEqual(save[1].threads, ['chat-1']);
  h.unmount();
});

test('edits made while Save sources is pending stay dirty and are not overwritten', async () => {
  const saved = deferred(), calls = [];
  const loaded = monitor('saved', { hostId: 'host-a', files: ['README.md'], threads: ['chat-1'] });
  const backend = { host: { id: 'host-a' }, call: async (command, args) => {
    calls.push([command, args]);
    if (command === 'monitor_get') return loaded;
    if (command === 'monitor_sources_update') return saved.promise;
    return loaded;
  } };
  const h = componentHarness(); const props = { ...base(backend), profiles: [profile], panes: [pane('chat-1'), pane('chat-2')] };
  let tree = h.render(props); await tick(); tree = h.render(props);
  removeButton(tree, 'README.md')?.props.onClick(); tree = h.render(props);
  saveButton(tree)?.props.onClick();
  await tick(); tree = h.render(props);
  const chat2 = find(tree, node => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked === false);
  chat2.props.onChange({ target: { checked: true } }); tree = h.render(props);
  saved.resolve({ ...loaded, files: [], threads: ['chat-1'] }); await tick(); tree = h.render(props);
  assert.equal(findAll(tree, node => node.type === 'input' && node.props.type === 'checkbox')[1]?.props.checked, true);
  saveButton(tree)?.props.onClick(); await tick();
  const saves = calls.filter(([command]) => command === 'monitor_sources_update');
  assert.deepEqual(saves[1]?.[1].threads, ['chat-1', 'chat-2']);
  h.unmount();
});

test('the sources sheet shows a saved profile that no longer exists as identified rather than blank', async () => {
  const loaded = monitor('saved', { hostId: 'host-a', profileId: 'deleted-profile' });
  const backend = { host: { id: 'host-a' }, call: async () => loaded };
  const h = componentHarness(); const props = { ...base(backend), profiles: [profile] };
  let tree = h.render(props); await tick(); tree = h.render(props);
  assert.match(visibleText(tree), /Saved profile — no longer in Agents/);
  h.unmount();
});

test('source edits preserve the current conversation owner and the save args', async () => {
  const calls = [], changes = [];
  const loaded = monitor('saved', { hostId: 'host-a', files: ['old.md'], threads: ['chat-1'] });
  const updated = { ...loaded, files: ['new.md'], threads: ['chat-2'] };
  const backend = { host: { id: 'host-a' }, call: async (command, args) => { calls.push([command, args]); return command === 'monitor_get' ? loaded : updated; } };
  const h = componentHarness(); const props = { ...base(backend, (...args) => changes.push(args)), profiles: [profile], panes: [pane('chat-1'), pane('chat-2')] };
  let tree = h.render(props); await tick(); tree = h.render(props);
  removeButton(tree, 'old.md')?.props.onClick();
  tree = h.render(props);
  saveButton(tree)?.props.onClick();
  await tick();
  const [command, args] = calls.find(([name]) => name === 'monitor_sources_update');
  assert.equal(command, 'monitor_sources_update');
  assert.deepEqual(args, { workspaceId: 'project', cwd: '/project', hostId: 'host-a', conversationId: 'conversation-1', files: [], threads: ['chat-1'], mode: 'replace' });
  assert.deepEqual(changes.at(-1), ['project', 'host-a', updated]);
  h.unmount();
});

test('viewing the sources sheet makes no changes beyond the monitor load', async () => {
  const calls = [];
  const loaded = monitor('saved', {
    paused: true,
    findings: [{ id: 'active', summary: 'Active work', reason: 'Needs attention', confidence: 'observed', status: 'open', evidence: [], snoozedUntil: null }],
  });
  const backend = { host: { id: 'host-a' }, call: async (command, args) => { calls.push([command, args]); return loaded; } };
  const h = componentHarness(); const props = { ...base(backend), profiles: [profile] };
  let tree = h.render(props); await tick(); tree = h.render(props);
  assert.ok(saveButton(tree));
  assert.deepEqual(calls.map(([command]) => command), ['monitor_get']);
  h.unmount();
});
