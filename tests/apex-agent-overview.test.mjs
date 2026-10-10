import test from 'node:test';
import assert from 'node:assert/strict';
import { overviewProject, visibleOverviewEntries, loadOverviewEntries, overviewOwner } from '../src/apexAgentOverview.ts';
const monitor = { workspaceId: 'a', cwd: '/a', hostId: 'local', conversationId: 'one', responsibility: 'Ship', profile: { apiKey: 'secret' }, messages: [{ id: 'm', role: 'assistant', text: 'Login failed', evidence: [] }], findings: [], decisions: ['Keep date'], preferences: [], completed: false, lastCheckedAt: 10 };
test('global context includes decisions and evidence but never sends saved profile secrets', () => {
  const context = overviewProject(monitor, 'Mobile', true);
  assert.equal(context.availability, 'offline');
  assert.equal(context.snapshot.messages[0].text, 'Login failed');
  assert.deepEqual(context.snapshot.decisions, ['Keep date']);
  assert.doesNotMatch(JSON.stringify(context), /secret|apiKey|profile/);
});
test('global memory is hidden and excluded from reasoning when a project is moved or reassigned', () => {
  const entry = { owners: [overviewOwner(monitor)] };
  assert.equal(visibleOverviewEntries([entry], [monitor]).length, 1);
  for (const changed of [{ cwd: '/elsewhere' }, { hostId: 'other' }, { conversationId: 'two' }]) assert.deepEqual(visibleOverviewEntries([entry], [{ ...monitor, ...changed }]), []);
  assert.deepEqual(visibleOverviewEntries([entry], []), []);
});
test('global conversation survives reopen and ignores corrupt history', () => {
  const entry = { workspaceId: '*', owners: [overviewOwner(monitor)], message: { id: 'global', at: 1, role: 'assistant', text: 'Summary', evidence: [] } };
  assert.deepEqual(loadOverviewEntries({ getItem: () => JSON.stringify([entry]) }), [entry]);
  assert.deepEqual(loadOverviewEntries({ getItem: () => '{bad' }), []);
  assert.deepEqual(loadOverviewEntries({ getItem: () => JSON.stringify([{ ...entry, owners: [null] }]) }), []);
});

test('handoff plans bind exact owners and revisions, reject offline and invented routing', async () => {
  const { handoffBatch } = await import('../src/apexAgentOverview.ts');
  const project = { ...overviewProject({ ...monitor, revision: 7 }, 'Mobile', false), routingThreads: [{ id: 'thread', workers: [{ id: 'null', display_name: 'Null' }] }] };
  const assignment = { owner: overviewOwner(monitor), revision: 7, brief: 'Fix login', destination: { threadId: 'thread', workers: ['null'], newThread: false }, reviewCriteria: ['Tests pass'] };
  const batch = handoffBatch('batch', 'Ask Null to fix Mobile login', [assignment], [project]);
  assert.equal(batch.children[0].payload.requestId, 'batch:0');
  assert.equal(batch.children[0].payload.mode, 'isolated');
  assert.equal(batch.children[0].payload.originalRequest, batch.originalRequest);
  for (const changed of [{ availability: 'offline' }, { conversationId: 'other' }, { revision: 8 }, { routingThreads: [] }]) assert.throws(() => handoffBatch('batch', 'Fix', [assignment], [{ ...project, ...changed }]));
  assert.throws(() => handoffBatch('batch', 'Fix', [{ ...assignment, mode: 'in_place' }], [project]));
});

test('recovery retains exact child payload and rejects changed owner scope', async () => {
  const { handoffBatch, loadHandoffBatches, saveHandoffBatches } = await import('../src/apexAgentOverview.ts');
  const project = { ...overviewProject({ ...monitor, revision: 7 }, 'Mobile', false), routingThreads: [{ id: 'thread', workers: [{ id: 'null' }] }] };
  const batch = handoffBatch('batch', 'Fix Mobile', [{ owner: overviewOwner(monitor), revision: 7, brief: 'Fix', destination: { threadId: 'thread', workers: ['null'], newThread: false } }], [project]);
  let saved; const storage = { setItem: (_key, value) => { saved = value; }, getItem: () => saved };
  saveHandoffBatches(storage, [batch]);
  assert.deepEqual(loadHandoffBatches(storage, [monitor]), [batch]);
  assert.deepEqual(loadHandoffBatches(storage, [{ ...monitor, hostId: 'other' }]), []);
  const bad = JSON.parse(saved); bad[0].children[0].payload.requestId = 'new-id'; saved = JSON.stringify(bad);
  assert.deepEqual(loadHandoffBatches(storage, [monitor]), []);
});

test('routing summaries are bounded and contain no worker credentials', async () => {
  const { overviewRouting } = await import('../src/apexAgentOverview.ts');
  const routing = overviewRouting({ routingThreads: [{ id: 'chat', workers: [{ id: 'null', display_name: 'Null', backend: { api_key: 'secret' }, access: 'full' }] }] });
  assert.deepEqual(routing, [{ id: 'chat', workers: [{ id: 'null', display_name: 'Null' }] }]);
  assert.doesNotMatch(JSON.stringify(routing), /secret|backend|access/);
});

test('a replaced child hides only its own plan while another saved child remains recoverable', async () => {
  const { visibleHandoffChildren } = await import('../src/apexAgentOverview.ts');
  const a = { payload: { owner: overviewOwner(monitor) } };
  const bMonitor = { ...monitor, workspaceId: 'b', cwd: '/b', conversationId: 'two' };
  const b = { payload: { owner: overviewOwner(bMonitor) } };
  assert.deepEqual(visibleHandoffChildren({ children: [a, b] }, [bMonitor]), [b]);
  assert.deepEqual(visibleHandoffChildren({ children: [a, b] }, [{ ...monitor, conversationId: 'replacement' }, bMonitor]), [b]);
});
