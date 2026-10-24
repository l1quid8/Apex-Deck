import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as runtime from '../src/assistantRuntime.ts';
const { transform } = createRequire(import.meta.url)('sucrase');
const source = fs.existsSync(new URL('../src/AssistantRuntimeSettings.tsx', import.meta.url)) ? fs.readFileSync(new URL('../src/AssistantRuntimeSettings.tsx', import.meta.url), 'utf8') : 'export function AssistantRuntimeSettings(){return null;}';
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
const text = n => typeof n === 'string' || typeof n === 'number' ? String(n) : n?.children?.map(text).join('') ?? '';
const find = (n, predicate) => !n || typeof n !== 'object' ? null : predicate(n) ? n : [...(n.children ?? []), n.props?.provider, n.props?.resets].map(child => find(child, predicate)).find(Boolean);
const BotSettings = () => null;
const tick = () => new Promise(resolve => setImmediate(resolve));
function mount(overrides = {}) {
  const profile = { id: 'saved', display_name: 'Null', persona: '', backend: { kind: 'agent', tool: 'claude_code', model: 'one' }, access: 'ask', effort: 'low' };
  let durable = { id: 'assistant-a', hostId: 'host-a', revision: 7, name: 'Null', profile, allowedFolders: ['/granted'], projects: [], costs: [] };
  const writes = [];
  const lane = { name: 'Null', hostName: 'Mac', offline: false, assistant: durable, configureWorkspace: async input => { writes.push(input); durable = { ...durable, profile: input.profile, revision: durable.revision + 1 }; }, ...overrides.lane };
  const backend = { sessionLoad:async()=>({profiles:[profile]}), agentModels: async () => [{ id: 'one', efforts: ['low', 'high'] }], detectAgents: async () => [{ key: 'claude_code', found: true }], call: async () => durable, ...overrides.backend };
  const props = { lane, backend, anchor: {}, profiles: [profile], close() {}, onSettings() {}, ...overrides, lane, backend };
  const state = [], deps = [], effects = [], cleanups = []; let cursor = 0;
  const useState = initial => { const i = cursor++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial; return [state[i], value => state[i] = typeof value === 'function' ? value(state[i]) : value]; };
  const useRef = initial => { const i = cursor++; return state[i] ??= { current: initial }; };
  const useMemo = (make, next) => { const i = cursor++; if (!(i in state) || next.some((v, j) => deps[i][j] !== v)) { state[i] = make(); deps[i] = next; } return state[i]; };
  const useEffect = (effect, next) => { const i = cursor++; if (!deps[i] || next.some((v, j) => deps[i][j] !== v)) { deps[i] = next; effects.push(() => { cleanups[i]?.(); cleanups[i] = effect(); }); } };
  const bindings = { React, useState, useRef, useMemo, useEffect, BotSettings, ...runtime, providerForConfig: c => c.backend.kind === 'agent' ? c.backend.tool : 'API' };
  const Component = new Function(...Object.keys(bindings), compiled + '\nreturn AssistantRuntimeSettings;')(...Object.values(bindings));
  return { props, writes, profile, render() { cursor = 0; const result = Component(props); effects.splice(0).forEach(effect => effect()); return result; }, async ready() { this.render(); await tick(); return this.render(); } };
}

test('Full access from quick settings waits for explicit bounded-folder confirmation', async () => {
  const h = mount(); const tree = await h.ready();
  const settings = find(tree, node => node.type === BotSettings);
  assert.ok(settings, 'shared BotSettings is mounted');
  const saving = settings.props.save({ ...h.profile, access: 'full' }, h.profile);
  await tick();
  assert.equal(h.writes.length, 0);
  assert.match(text(h.render().props.provider), /\/granted/);
  find(h.render(), node => node.type === 'button' && text(node) === 'Use Full access').props.onClick();
  await saving;
  assert.equal(h.writes[0].profile.access, 'full');
  assert.equal(h.writes[0].expectedRevision, 7);
  assert.equal(Object.hasOwn(h.writes[0], 'projects'), false);
});

test('unavailable runtime disables quick changes with a reason and keeps Full Settings available', async () => {
  const h = mount({ backend: { detectAgents: async () => [{ key: 'claude_code', found: false }] } });
  const tree = await h.ready();
  const settings = find(tree, node => node.type === BotSettings);
  assert.ok(settings, 'shared BotSettings remains visible');
  assert.match(settings.props.disabledReason, /not installed/);
  assert.ok(find(tree, node => node.type === 'button' && text(node) === 'Full Settings'));
  assert.equal(settings.props.roomId, undefined);
});

const workspaceSource = fs.readFileSync(new URL('../src/AssistantWorkspace.tsx', import.meta.url), 'utf8');
const workspaceCompiled = transform(workspaceSource.replace(/^import .*;\n/gm, '').replace(/^export (?:type )?\{.*$/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const AssistantRuntimeSettings = () => null;
const Avatar = () => null;
function workspaceHarness() {
  const profile = { id: 'saved', display_name: 'Null', backend: { kind: 'agent', tool: 'claude_code', model: 'one' }, access: 'ask', effort: 'high' };
  const events = [], state = []; let cursor = 0;
  const useState = initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => state[i] = value]; };
  const bindings = { React, useState, useEffect() {}, useMemo: make => make(), useSyncExternalStore: (sub, get) => get(), voiceController: { subscribe: () => () => {}, getState: () => ({ status: 'off', muted: false }) }, Clock: () => null, AssistantRuntimeSettings, Avatar, PersonalPanels: () => null, createAssistantAvatarApi: () => undefined, assistantAppearance: () => ({ seed: 'a', color: '#fff' }), assistantStatus: () => ({ state: 'ready', label: 'Ready', working: 0, needsYou: 0, failed: 0 }), accessLabel: () => 'Ask first' };
  const Component = new Function(...Object.keys(bindings), workspaceCompiled + '\nreturn AssistantWorkspace;')(...Object.values(bindings));
  const props = { lane: { name: 'Null', hostName: 'Mac', assistant: { id: 'a', hostId: 'h', name: 'Null', profile }, configureWorkspace: async () => {}, browserView: async () => {} }, backend: {}, section: 'chat', onNavigate: section => events.push(section), onOpenBrowser: () => events.push('browser'), chat: 'Draft retained', projects: 'Projects', editor: 'Settings', callControls: React.createElement('span', {}, 'Shared voice control'), detailsOpen: false, onToggleDetails: () => events.push('details') };
  return { props, events, render() { cursor = 0; return Component(props); } };
}

test('the avatar opens Details and the runtime popover is gone from the workspace', () => {
  const h = workspaceHarness(); let tree = h.render();
  const trigger = find(tree, node => node.type === 'button' && /details$/.test(String(node.props['aria-label'] ?? '')));
  assert.ok(trigger, 'the session capsule carries one details control');
  assert.equal(trigger.props['aria-expanded'], false);
  assert.equal(trigger.props['aria-controls'], 'assistant-details');
  trigger.props.onClick(); h.render();
  assert.deepEqual(h.events, ['details']);
  assert.match(text(trigger), /Null/);
  assert.doesNotMatch(text(trigger), /Claude|Ask first|project/i, 'the runtime line moved into the Details sidebar');
  assert.ok(find(tree, node => node.type === 'summary' && text(node).includes('⋯')), 'the ⋯ menu is still the way into the subviews');
  // Model & access now folds open inside Details, so the ⋯ popover must be gone
  // and nothing in the workspace may still mount the runtime controls.
  assert.equal(find(tree, node => node.type === 'button' && text(node) === 'Model & access'), undefined);
  assert.equal(find(tree, node => node.type === AssistantRuntimeSettings), undefined);
  assert.match(text(tree), /Shared voice control/);
  for (const label of ['Browser', 'Projects & access', 'Memory', 'Settings']) {
    find(tree, node => node.type === 'button' && text(node) === label).props.onClick({ currentTarget: { closest: () => ({ removeAttribute() {} }) } });
  }
  assert.deepEqual(h.events, ['details', 'browser', 'projects', 'memory', 'settings']);
});

test('nested Memory and Settings Back controls name their actual source',()=>{
 for(const [section,previous,label] of [['memory','settings','‹ Settings'],['settings','memory','‹ Memory']]){
  const h=workspaceHarness();h.props.section=section;h.props.previousSection=previous;const tree=h.render();const back=find(tree,n=>n.type==='button'&&text(n)===label);assert.ok(back,`${section} returns to ${previous}`);back.props.onClick();assert.deepEqual(h.events,[previous]);
 }
});

test('remote runtime selector lists owning-host accounts instead of unrelated desktop profiles',async()=>{
 const remote={id:'remote',display_name:'Remote account',backend:{kind:'open_ai_compatible',base_url:'https://remote.test/v1',model:'text'}};
 const h=mount({profiles:[{id:'local',display_name:'Local-only account',backend:{kind:'agent',tool:'codex'}}],backend:{sessionLoad:async()=>({profiles:[remote,{id:'bad',display_name:'Connected Codex',backend:{kind:'agent',tool:'codex'}}]})}});
 const tree=await h.ready();const selector=find(tree,n=>n.type==='select'&&n.props['aria-label']==='Assistant runtime provider');assert.match(text(selector),/Remote account/);assert.doesNotMatch(text(selector),/Local-only/);assert.match(text(selector),/Connected Codex/);
});
