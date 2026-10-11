import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { compatibleMonitorProfiles } from '../src/apexAgentModel.ts';

const require = createRequire(import.meta.url);
const { transform } = require('sucrase');
const source = fs.readFileSync(new URL('../src/ApexAgentSources.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace('export function ApexAgentSources', 'function ApexAgentSources'), {
  transforms: ['typescript', 'jsx'], jsxRuntime: 'classic',
}).code;

// Same render harness as apex-agent-callbacks.test.mjs: hooks run in order and effects run after each render.
function harness() {
  const states = [], refs = [], effects = [];
  let cursor = 0, mounted = true;
  const intervals = new Set();
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { if (mounted) states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return refs[i] ??= { current: initial }; },
    useMemo(fn) { cursor++; return fn(); },
    useEffect(fn, deps) { const i = cursor++; const prev = effects[i]; if (!prev || !deps || deps.some((v, j) => !Object.is(v, prev.deps[j]))) effects[i] = { fn, deps, changed: true }; },
  };
  const component = new Function('React', 'useState', 'useRef', 'useMemo', 'useEffect', 'compatibleMonitorProfiles', 'defaultMonitorProfileId', 'parseProjectFiles', 'workspaceHost', 'window', `${compiled}; return ApexAgentSources;`)(
    React, hooks.useState, hooks.useRef, hooks.useMemo, hooks.useEffect,
    compatibleMonitorProfiles, (_profiles, stored) => stored ?? 'profile-1',
    text => text.split('\n').map(line => line.trim()).filter(path => path && !path.startsWith('../') && !path.startsWith('/')),
    w => w.hostId ?? 'local',
    { confirm: () => true, localStorage: { getItem: () => null, setItem() {} }, setInterval: fn => { intervals.add(fn); return fn; }, clearInterval: fn => intervals.delete(fn) },
  );
  let props;
  function render(nextProps = props) {
    props = nextProps; cursor = 0;
    const tree = component(props);
    for (const effect of effects) if (effect?.changed) { effect.changed = false; effect.cleanup?.(); effect.cleanup = effect.fn(); }
    return tree;
  }
  function unmount() { mounted = false; for (const effect of effects) effect?.cleanup?.(); intervals.clear(); }
  return { render, unmount };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const find = (node, predicate) => { if (!node || typeof node !== 'object') return null; if (Array.isArray(node)) { for (const child of node) { const found = find(child, predicate); if (found) return found; } return null; } if (predicate(node)) return node; for (const child of node.children ?? []) { const found = find(child, predicate); if (found) return found; } return null; };
const findAll = (node, predicate, matches = []) => { if (!node || typeof node !== 'object') return matches; if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, matches); return matches; } if (predicate(node)) matches.push(node); for (const child of node.children ?? []) findAll(child, predicate, matches); return matches; };
const visibleText = node => !node || typeof node !== 'object' ? String(node ?? '') : Array.isArray(node) ? node.map(visibleText).join(' ') : (node.children ?? []).map(visibleText).join(' ');

const workspace = { id: 'project', name: 'Billing API', hostId: 'host-a', path: '/billing' };
const profile = { id: 'profile-1', display_name: 'Local chat', backend: { kind: 'open_ai_compatible' }, media: null };
const pane = (id, title = id) => ({ id, title, kind: 'chat', workspaceId: 'project', archived: false });
const monitor = (overrides = {}) => ({
  workspaceId: 'project', conversationId: 'conversation-1', cwd: '/billing', hostId: 'host-a', profileId: 'profile-1',
  responsibility: 'Keep billing green', nextStep: '', decisions: [], preferences: [], files: [], threads: [], paused: false, completed: false,
  revision: 1, messages: [], findings: [], activity: [], lastCheckedAt: null, nextCheckAt: null, wakeReason: null,
  evidenceFingerprint: null, activeCheck: null, error: null, ...overrides,
});
const props = (backend, extra = {}) => ({
  workspace, backend, profiles: [profile], panes: [pane('chat-1', 'Planning'), pane('chat-2', 'Review')],
  onBack() {}, onClose() {}, onMonitorChange() {}, ...extra,
});

test('an unwatched project shows the AI profile, the keep-on-track question, and Start watching', async () => {
  const backend = { host: { id: 'host-a' }, call: async () => null };
  const h = harness();
  let tree = h.render(props(backend)); await tick(); tree = h.render(props(backend));
  assert.match(visibleText(tree), /Sources · Billing API/);
  assert.equal(find(tree, node => node.type === 'select')?.props.value, 'profile-1');
  assert.match(visibleText(tree), /keep on track in\s+Billing API\s*\?/);
  assert.ok(find(tree, node => node.type === 'textarea'));
  assert.ok(find(tree, node => node.type === 'button' && node.children?.[0] === 'Start watching'));
  assert.equal(find(tree, node => node.type === 'input' && node.props.type === 'checkbox'), null, 'no chat toggles before watching');
  h.unmount();
});

test('a watched project lists its chats with toggles and its files with remove buttons, and hides deleted chats', async () => {
  const backend = { host: { id: 'host-a' }, call: async () => monitor({ files: ['README.md'], threads: ['chat-1', 'gone'] }) };
  const h = harness();
  let tree = h.render(props(backend)); await tick(); tree = h.render(props(backend));
  const toggles = findAll(tree, node => node.type === 'input' && node.props.type === 'checkbox');
  assert.deepEqual(toggles.map(node => node.props.checked), [true, false], 'one toggle per existing chat, reflecting the monitor');
  assert.match(visibleText(tree), /Planning/);
  assert.match(visibleText(tree), /Review/);
  assert.doesNotMatch(visibleText(tree), /gone/, 'a deleted chat is not shown as a toggle');
  assert.ok(find(tree, node => node.type === 'button' && node.props['aria-label'] === 'Remove README.md' && node.children?.[0] === '✕'));
  assert.ok(find(tree, node => node.type === 'input' && node.props['aria-label'] === 'Add a file path'));
  assert.match(visibleText(tree), /AI profile ·\s+Local chat/);
  h.unmount();
});

test('a save reply that names removed chats shows one quiet Removed line', async () => {
  const backend = { host: { id: 'host-a' }, call: async (command) => command === 'monitor_get'
    ? monitor({ threads: ['chat-1', 'gone'] })
    : { ...monitor({ threads: ['chat-1'] }), removedThreads: ['gone'] } };
  const h = harness();
  let tree = h.render(props(backend)); await tick(); tree = h.render(props(backend));
  find(tree, node => node.type === 'button' && node.children?.[0] === 'Save sources')?.props.onClick();
  await tick(); tree = h.render(props(backend));
  assert.match(visibleText(tree), /Saved. Removed 1 deleted chat from sources\./);
  h.unmount();
});

test('a save with nothing removed still confirms it saved', async () => {
  const backend = { host: { id: 'host-a' }, call: async () => monitor({ threads: ['chat-1'] }) };
  const h = harness();
  let tree = h.render(props(backend)); await tick(); tree = h.render(props(backend));
  assert.doesNotMatch(visibleText(tree), /Saved\./);
  find(tree, node => node.type === 'button' && node.children?.[0] === 'Save sources')?.props.onClick();
  await tick(); tree = h.render(props(backend));
  assert.match(visibleText(tree), /Saved\./);
  h.unmount();
});
