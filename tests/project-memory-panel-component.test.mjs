import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { assistantIdentityKey, projectIdentityKey } from '../src/assistantIdentity.ts';
import { createProjectMemoryClient } from '../src/projectMemory.ts';

const { transform } = createRequire(import.meta.url)('sucrase');
const source = fs.readFileSync(new URL('../src/ProjectMemoryPanel.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
const textOf = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(textOf).join('') ?? '';
const find = (node, predicate) => !node || typeof node !== 'object' ? null : predicate(node) ? node : node.children?.map(child => find(child, predicate)).find(Boolean) ?? null;
const findAll = (node, predicate, result = []) => { if (!node || typeof node !== 'object') return result; if (predicate(node)) result.push(node); node.children?.forEach(child => findAll(child, predicate, result)); return result; };
const button = (tree, label) => find(tree, node => node.type === 'button' && textOf(node) === label);
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const projectA = { hostId: 'alpha', workspaceId: 'a', cwd: '/repo/a' };
const projectB = { hostId: 'alpha', workspaceId: 'b', cwd: '/repo/b' };
const result = (project = projectA, text = 'Shared decision') => ({ project, notes: [{ id: 'note-1', project, text, kind: 'decision', version: 3, createdAt: 1000, updatedAt: 3000, author: { hostId: 'alpha', assistantId: 'asst-1' }, source: { taskId: 'task-7', attempt: 2, runId: 'run-4', scratchId: 'scratch-3' } }], sources: [{ id: 'monitor-1', text: 'Existing monitor decision', kind: 'decision', source: 'monitor', readOnly: true, updatedAt: 2000 }], readAt: 4000 });

function fixture() {
  const calls = [], handlers = {};
  const ref = { hostId: 'alpha', assistantId: 'asst-1' };
  const route = { supports: () => true, call: async (command, args) => { calls.push([command, args]); return handlers[command] ? handlers[command](args) : command === 'project_memory_save' ? { ...result(args.project).notes[0], author: null, source: {}, text: args.text } : result(args.project); } };
  const lane = { ref, name: 'Dot', hostName: 'Alpha', offline: false, assistant: { id: 'asst-1', hostId: 'alpha', projects: [{ project: projectA, tools: 'full' }, { project: projectB, tools: 'off' }], facts: [{ text: 'Private assistant secret' }] }, projectMemory: createProjectMemoryClient({ assistant: ref, route, assertAvailable() {}, assertBinding() {} }) };
  return { lane, calls, handlers };
}

function mount(lane, props = {}) {
  const hooks = []; let cursor = 0, effects = [], currentLane = lane;
  const useState = initial => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; };
  const useRef = initial => { const i = cursor++; return hooks[i] ??= { current: initial }; };
  const useEffect = (effect, deps) => { const i = cursor++; const old = hooks[i]; if (!old || !deps || deps.some((value, index) => value !== old.deps?.[index])) { effects.push(() => { old?.cleanup?.(); hooks[i] = { deps, cleanup: effect() }; }); } };
  const component = new Function('React', 'useState', 'useEffect', 'useRef', 'assistantIdentityKey', 'projectIdentityKey', `${compiled}\nreturn ProjectMemoryPanel;`)(React, useState, useEffect, useRef, assistantIdentityKey, projectIdentityKey);
  return { lane(value) { currentLane = value; }, render() { cursor = 0; effects = []; const tree = component({ lane: currentLane, ...props }); effects.forEach(effect => effect()); return tree; } };
}

test('project notebook reads only its selected binding and exposes versions, provenance and read-only monitor sources', async () => {
  const f = fixture(), h = mount(f.lane); h.render(); await settle(); const tree = h.render();
  assert.match(textOf(tree), /Shared decision/);
  assert.match(textOf(tree), /note-1.*version 3/);
  assert.match(textOf(tree), /task-7.*attempt 2.*run-4.*scratch-3/);
  assert.match(textOf(tree), /Read at/);
  assert.doesNotMatch(textOf(tree), /Private assistant secret/);
  assert.deepEqual(f.calls, [['project_memory_list', { assistant: f.lane.ref, project: projectA }]]);
  const monitor = find(tree, node => node.props?.['data-memory-source'] === 'monitor');
  assert.match(textOf(monitor), /Existing monitor decision.*monitor-1.*Read only/s);
  assert.equal(findAll(monitor, node => node.type === 'button').length, 0);
  const select = find(tree, node => node.props?.['aria-label'] === 'Project notebook');
  assert.equal(findAll(select, node => node.type === 'option').length, 2);
});

test('a late project read cannot replace a more recently selected project', async () => {
  const f = fixture(), a = deferred(), b = deferred();
  f.handlers.project_memory_list = args => args.project.workspaceId === 'a' ? a.promise : b.promise;
  const h = mount(f.lane); let tree = h.render();
  const select = find(tree, node => node.props?.['aria-label'] === 'Project notebook'); assert.ok(select);
  select.props.onChange({ target: { value: projectIdentityKey(projectB) } }); h.render();
  b.resolve(result(projectB, 'Project B decision')); await settle(); tree = h.render(); assert.match(textOf(tree), /Project B decision/);
  a.resolve(result(projectA, 'Project A private to project')); await settle(); tree = h.render();
  assert.match(textOf(tree), /Project B decision/); assert.doesNotMatch(textOf(tree), /Project A private to project/);
});

test('correcting a note sends its inspected version and keeps the draft visible when the host rejects a stale edit', async () => {
  const f = fixture(), h = mount(f.lane); h.render(); await settle(); let tree = h.render();
  assert.ok(button(tree, 'Correct')); button(tree, 'Correct').props.onClick(); tree = h.render();
  find(tree, node => node.props?.['aria-label'] === 'Corrected project note').props.onChange({ target: { value: 'Retained correction' } }); tree = h.render();
  f.handlers.project_memory_save = () => { throw new Error('Note version conflict. Refresh and review the current note.'); };
  button(tree, 'Save correction').props.onClick(); await settle(); tree = h.render();
  assert.match(textOf(find(tree, node => node.props?.role === 'alert')), /version conflict/);
  assert.equal(find(tree, node => node.props?.['aria-label'] === 'Corrected project note').props.value, 'Retained correction');
  assert.deepEqual(f.calls.filter(([command]) => command === 'project_memory_save'), [['project_memory_save', { assistant: f.lane.ref, project: projectA, id: 'note-1', expectedVersion: 3, text: 'Retained correction', kind: 'decision' }]]);
});

test('old and offline notebooks show a concrete unavailable state without making a read request', async () => {
  const f = fixture(); f.lane.projectMemory = undefined; f.lane.projectMemoryProblem = 'Update Alpha to use project memory.';
  let h = mount(f.lane), tree = h.render(); await settle(); assert.match(textOf(tree), /Update Alpha/); assert.deepEqual(f.calls, []);
  f.lane.offline = true; f.lane.projectMemory = createProjectMemoryClient({ assistant: f.lane.ref, route: { supports: () => true, call: async () => assert.fail('offline read') }, assertAvailable() { throw new Error("This assistant's machine is offline."); }, assertBinding() {} });
  h = mount(f.lane); tree = h.render(); await settle(); assert.match(textOf(tree), /offline/);
  f.lane.assistant.projects = [];
  h = mount(f.lane); tree = h.render(); assert.match(textOf(tree), /offline/);
  f.lane.offline = false; f.lane.projectMemory = undefined;
  h = mount(f.lane); tree = h.render(); assert.match(textOf(tree), /Update Alpha/);
});

test('a saved-note receipt clears the submitted draft even when the following inspection fails', async () => {
  const f = fixture(), h = mount(f.lane); h.render(); await settle(); let tree = h.render();
  find(tree, node => node.props?.['aria-label'] === 'New shared project note').props.onChange({ target: { value: 'Saved once' } }); tree = h.render();
  f.handlers.project_memory_list = () => { throw new Error('Connection dropped during read'); };
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await settle(); tree = h.render();
  assert.equal(find(tree, node => node.props?.['aria-label'] === 'New shared project note').props.value, '');
  assert.match(textOf(find(tree, node => node.props?.role === 'alert')), /saved.*refresh/i);
  assert.equal(f.calls.filter(([command]) => command === 'project_memory_save').length, 1);
});

test('switching projects during a save cannot leave the original project permanently busy', async () => {
  const f = fixture(), h = mount(f.lane), saving = deferred(); h.render(); await settle(); let tree = h.render();
  button(tree, 'Correct').props.onClick(); tree = h.render();
  f.handlers.project_memory_save = () => saving.promise; button(tree, 'Save correction').props.onClick();
  find(tree, node => node.props?.['aria-label'] === 'Project notebook').props.onChange({ target: { value: projectIdentityKey(projectB) } }); h.render(); await settle();
  saving.resolve({ ...result().notes[0], author: null, source: {} }); await settle(); tree = h.render();
  find(tree, node => node.props?.['aria-label'] === 'Project notebook').props.onChange({ target: { value: projectIdentityKey(projectA) } }); h.render(); await settle(); tree = h.render();
  assert.equal(button(tree, 'Correct').props.disabled, false);
});

test('embedded notebook search and edit retain inspected project/version and source details', async () => {
  const f = fixture();
  const h = mount(f.lane, { embedded: true, selectedProject: projectB, notebookControl: React.createElement('select', { 'aria-label': 'Memory notebook' }) });
  h.render(); await settle(); let tree = h.render();
  assert.deepEqual(f.calls[0], ['project_memory_list', { assistant: f.lane.ref, project: projectB }]);
  assert.match(textOf(tree), /Shared decision.*Version 3/s);
  assert.equal(findAll(tree, node => node.type === 'select').length, 1);
  find(tree, node => node.props?.['aria-label'] === 'Search notes').props.onChange({ target: { value: 'absent' } }); tree = h.render();
  assert.doesNotMatch(textOf(tree), /Shared decision/);
  assert.match(textOf(tree), /No notes match your search/);
  find(tree, node => node.props?.['aria-label'] === 'Search notes').props.onChange({ target: { value: '' } }); tree = h.render();
  const record = find(tree, node => node.type === 'details' && textOf(node).startsWith('Record and source'));
  assert.match(textOf(record), /note-1.*version 3.*task-7.*run-4/s);
  assert.equal(record.props.open, false);
  button(tree, 'Edit').props.onClick(); tree = h.render();
  button(tree, 'Save correction').props.onClick(); await settle();
  assert.deepEqual(f.calls.find(([command]) => command === 'project_memory_save')[1], { assistant: f.lane.ref, project: projectB, id: 'note-1', expectedVersion: 3, text: 'Shared decision', kind: 'decision' });
});

test('initialProject opens the requested assigned notebook instead of the first project', async () => {
  const f = fixture();
  const h = mount(f.lane, { initialProject: projectB });
  h.render(); await settle(); const tree = h.render();
  assert.deepEqual(f.calls[0], ['project_memory_list', { assistant: f.lane.ref, project: projectB }]);
  assert.equal(find(tree, node => node.props?.['aria-label'] === 'Project notebook').props.value, projectIdentityKey(projectB));
});

test('embedded edit displays a freshly inspected saved note and keeps it searchable', async () => {
  const f = fixture();
  let durable = result(projectB);
  f.handlers.project_memory_list = () => structuredClone(durable);
  f.handlers.project_memory_save = args => {
    assert.equal(args.expectedVersion, durable.notes[0].version);
    durable.notes[0] = { ...durable.notes[0], text: args.text, version: args.expectedVersion + 1, updatedAt: 5000 };
    return structuredClone(durable.notes[0]);
  };
  const h = mount(f.lane, { embedded: true, initialProject: projectB });
  h.render(); await settle(); let tree = h.render();
  button(tree, 'Edit').props.onClick(); tree = h.render();
  find(tree, node => node.props?.['aria-label'] === 'Corrected project note').props.onChange({ target: { value: 'Reviewed release decision' } }); tree = h.render();
  button(tree, 'Save correction').props.onClick(); await settle(); tree = h.render();
  assert.match(textOf(tree), /Reviewed release decision.*Version 4/s);
  assert.equal(f.calls.filter(([command]) => command === 'project_memory_list').length, 2, 'fresh inspection follows the durable save receipt');
  find(tree, node => node.props?.['aria-label'] === 'Search notes').props.onChange({ target: { value: 'release' } }); tree = h.render();
  assert.match(textOf(tree), /Reviewed release decision/);
  const reopened = mount(f.lane, { embedded: true, initialProject: projectB });
  reopened.render(); await settle();
  assert.match(textOf(reopened.render()), /Reviewed release decision.*Version 4/s);
});
