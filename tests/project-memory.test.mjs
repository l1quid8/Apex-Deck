import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalAssistantsCollection } from '../src/usePersonalAssistants.ts';

const assistant = { hostId: 'alpha', assistantId: 'asst-1' };
const project = { hostId: 'alpha', workspaceId: 'work-a', cwd: '/projects/a' };
const otherProject = { hostId: 'alpha', workspaceId: 'work-b', cwd: '/projects/b' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const record = (hostId = 'alpha', revision = 7) => ({
  id: 'asst-1', hostId, revision, name: hostId, timezone: 'UTC', profile: null, allowedFolders: ['/projects'], messages: [], tasks: [], style: '',
  modes: { read: 'ask', write: 'ask', send: 'ask', spend: 'ask' }, budget: {}, privacy: { localOnly: false, allowedEndpoints: [] }, contextBudgetChars: 1000,
  projects: [{ project: { ...project }, tools: 'full' }, { project: { ...otherProject }, tools: 'off' }],
});
const note = (overrides = {}) => ({ id: 'note-1', project: { ...project }, text: 'Use the staged release folder', kind: 'decision', version: 3,
  createdAt: 1000, updatedAt: 3000, author: { ...assistant }, source: { taskId: 'task-1', attempt: 2, runId: 'run-1', scratchId: 'scratch-1' }, ...overrides });
const listing = (overrides = {}) => ({ project: { ...project }, notes: [note()], sources: [{ id: 'monitor-decision', text: 'Keep receipts', kind: 'decision', readOnly: true, source: 'monitor', updatedAt: 2000 }], readAt: 4000, ...overrides });

function fixture({ capable = true } = {}) {
  const calls = [], handlers = {}, offline = new Set(), records = { a: [record()], b: [record('beta')] };
  const identities = { a: 'alpha', b: 'beta' };
  const routes = Object.fromEntries(['a', 'b'].map(id => [id, {
    host: { connection: { get: () => ({ status: { kind: 'connected', hostId: identities[id] } }) } },
    supports: capability => capable && capability === 'assistant_project_memory_v1',
    call: async (command, args) => {
      calls.push([id, command, args]);
      if (handlers[`${id}:${command}`]) return handlers[`${id}:${command}`](args);
      if (command === 'personal_list') return records[id];
      if (command === 'project_memory_list') return listing();
      if (command === 'project_memory_save') return note({ id: 'note-2', version: 1, text: args.text });
      if (command === 'project_memory_forget') return note({ text: '', version: 4, deletedAt: 5000 });
      return { assistant: record(id === 'a' ? 'alpha' : 'beta', 8) };
    },
  }]));
  const options = { hosts: [{ id: 'a', name: 'Alpha', remote: true }, { id: 'b', name: 'Beta', remote: true }], hostBackend: id => routes[id], offlineHost: id => offline.has(id) };
  return { collection: new PersonalAssistantsCollection(options), options, calls, handlers, offline, records, identities, routes };
}

test('memory reads return inspectable project provenance without issuing any mutation or unrelated read', async () => {
  const f = fixture(); await f.collection.refresh(); const lane = f.collection.lane(assistant);
  assert.ok(lane.projectMemory, 'negotiated project notebook is available');
  const result = await lane.projectMemory.list(project);
  assert.deepEqual(result, listing());
  assert.deepEqual(f.calls.filter(([, command]) => command !== 'personal_list'), [['a', 'project_memory_list', { assistant, project }]]);
});

test('project edits capture immutable owners and carry the inspected version across selection changes', async () => {
  const f = fixture(); await f.collection.refresh(); const lane = f.collection.lane(assistant);
  assert.ok(lane.projectMemory);
  const pending = deferred(); f.handlers['a:project_memory_save'] = () => pending.promise;
  const mutableProject = { ...project };
  const saving = lane.projectMemory.save({ project: mutableProject, id: 'note-1', expectedVersion: 3, text: 'Corrected decision', kind: 'decision' });
  mutableProject.hostId = 'beta'; mutableProject.cwd = '/wrong'; lane.ref.hostId = 'wrong'; f.collection.select({ hostId: 'beta', assistantId: 'asst-1' });
  pending.resolve(note({ id: 'note-2', text: 'Corrected decision', version: 1 }));
  assert.equal((await saving).id, 'note-2');
  assert.deepEqual(f.collection.snapshot().selected, { hostId: 'beta', assistantId: 'asst-1' });
  assert.deepEqual(f.calls.find(([, command]) => command === 'project_memory_save'), ['a', 'project_memory_save', {
    assistant, project, id: 'note-1', expectedVersion: 3, text: 'Corrected decision', kind: 'decision',
  }]);
});

test('unassigned, cross-host, old and offline notebooks fail before any read or mutation probe', async () => {
  const f = fixture(); await f.collection.refresh(); const lane = f.collection.lane(assistant); assert.ok(lane.projectMemory);
  await assert.rejects(lane.projectMemory.list({ ...project, workspaceId: 'unassigned' }), /assign|bound/i);
  f.records.a = [{ ...record('alpha', 8), projects: [{ project: { ...project, hostId: 'beta' }, tools: 'full' }] }]; await f.collection.refresh();
  const cross = f.collection.lane(assistant); await assert.rejects(cross.projectMemory.list({ ...project, hostId: 'beta' }), /same.*machine|cross.host|remote.*unavailable/i);
  f.offline.add('a'); await assert.rejects(cross.projectMemory.list(project), /offline/i);
  assert.equal(f.calls.some(([, command]) => command.startsWith('project_memory_')), false);
  const old = fixture({ capable: false }); await old.collection.refresh();
  assert.equal(old.collection.lane(assistant).projectMemory, undefined);
  assert.match(old.collection.lane(assistant).projectMemoryProblem, /update|support/i);
  assert.equal(old.calls.some(([, command]) => command.startsWith('project_memory_')), false);
});

test('captured notebook rejects late results after owner replacement or project unassignment', async () => {
  const f = fixture(); await f.collection.refresh(); const api = f.collection.lane(assistant).projectMemory; assert.ok(api);
  const pending = deferred(); f.handlers['a:project_memory_list'] = () => pending.promise;
  const reading = api.list(project); f.identities.a = 'replacement'; pending.resolve(listing());
  await assert.rejects(reading, /identity|offline/i);
  f.identities.a = 'alpha'; const another = deferred(); f.handlers['a:project_memory_list'] = () => another.promise;
  const readingAgain = api.list(project); f.records.a = [{ ...record('alpha', 8), projects: [] }]; await f.collection.refresh(); another.resolve(listing());
  await assert.rejects(readingAgain, /assign|bound/i);
});

test('foreign project responses and malformed note versions are rejected', async () => {
  const f = fixture(); await f.collection.refresh(); const api = f.collection.lane(assistant).projectMemory; assert.ok(api);
  f.handlers['a:project_memory_list'] = () => listing({ notes: [note({ project: otherProject })] });
  await assert.rejects(api.list(project), /project/i);
  f.handlers['a:project_memory_list'] = () => listing({ notes: [note({ version: -1 })] });
  await assert.rejects(api.list(project), /version|invalid/i);
});

test('Rust-shaped human notes omit optional fields and malformed source provenance is rejected', async () => {
  const f = fixture(); await f.collection.refresh(); const api = f.collection.lane(assistant).projectMemory; assert.ok(api);
  const humanNote = { id: 'human-note', project, text: 'Human notebook edit', kind: 'fact', version: 1, createdAt: 1000, updatedAt: 1000, author: null, source: {} };
  f.handlers['a:project_memory_list'] = () => listing({ notes: [humanNote] });
  assert.deepEqual((await api.list(project)).notes, [humanNote]);
  for (const source of [{ taskId: 12 }, { attempt: '2' }, { attempt: 0 }, { attempt: -1 }, { attempt: 1.5 }, { runId: false }, { scratchId: [] }, { messageId: {} }]) {
    f.handlers['a:project_memory_list'] = () => listing({ notes: [{ ...humanNote, source }] });
    await assert.rejects(api.list(project), /source|provenance|invalid/i);
  }
});

test('edit and forget require a version and host conflicts remain visible without automatic retry', async () => {
  const f = fixture(); await f.collection.refresh(); const api = f.collection.lane(assistant).projectMemory; assert.ok(api);
  await assert.rejects(api.save({ project, id: 'note-1', text: 'Bad', kind: 'fact' }), /version/i);
  await assert.rejects(api.forget({ project, id: 'note-1' }), /version/i);
  assert.equal(f.calls.some(([, command]) => command.startsWith('project_memory_')), false);
  f.handlers['a:project_memory_save'] = () => { throw new Error('Project note version conflict; refresh before saving'); };
  await assert.rejects(api.save({ project, id: 'note-1', expectedVersion: 2, text: 'Stale', kind: 'fact' }), /version conflict/i);
  assert.equal(f.calls.filter(([, command]) => command === 'project_memory_save').length, 1);
  const forgotten = await api.forget({ project, id: 'note-1', expectedVersion: 3 });
  assert.equal(forgotten.text, ''); assert.equal(forgotten.deletedAt, 5000);
  assert.deepEqual(f.calls.at(-1), ['a', 'project_memory_forget', { assistant, project, id: 'note-1', expectedVersion: 3 }]);
});

test('private-memory mutation revision is captured by the editor and omitted entirely for old hosts', async () => {
  const f = fixture(); await f.collection.refresh(); const lane = f.collection.lane(assistant);
  lane.assistant.revision = 99;
  await lane.remember('Private preference'); await lane.correctFact('fact-1', 'Correction'); await lane.forgetFact('fact-1');
  for (const [, , args] of f.calls.filter(([, command]) => command.startsWith('personal_memory_'))) assert.equal(args.expectedRevision, 7);
  const old = fixture({ capable: false }); await old.collection.refresh(); const legacy = old.collection.lane(assistant);
  await legacy.remember('Legacy'); await legacy.correctFact('fact-1', 'Legacy correction'); await legacy.forgetFact('fact-1');
  for (const [, , args] of old.calls.filter(([, command]) => command.startsWith('personal_memory_'))) assert.equal(Object.hasOwn(args, 'expectedRevision'), false);
});
