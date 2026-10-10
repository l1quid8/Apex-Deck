import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantProfileChoices, taskWorkerChoices, isTaskOwnedBy, taskStatusLabel, taskUsageLabel, retainRequestForRetry, taskThreadLinks, isSnapshotForOwner, assistantTasksForOwner, assistantMessageArgs, pendingRequestStorageKey, loadPendingRequest, savePendingRequest, clearPendingRequest, archivedTaskIds, canReconcileTask, shouldSuggestArchive } from '../src/assistantTaskModel.ts';

const profiles = [
  { id: 'http', backend: { kind: 'open_ai_compatible' }, media: null },
  { id: 'claude', backend: { kind: 'agent', tool: 'claude_code' }, media: null },
  { id: 'codex', backend: { kind: 'agent', tool: 'codex' }, media: null },
  { id: 'grok', backend: { kind: 'agent', tool: 'grok' }, media: null },
  { id: 'gemini', backend: { kind: 'agent', tool: 'gemini' }, media: null },
  { id: 'cli', backend: { kind: 'cli' }, media: null },
  { id: 'media', backend: { kind: 'open_ai_compatible' }, media: {} },
];

test('assistant profiles are limited to HTTP and Claude Code text profiles', () => {
  assert.deepEqual(assistantProfileChoices(profiles).map(profile => profile.id), ['http', 'claude']);
});

test('task owner matching checks the whole workspace and conversation binding', () => {
  const owner = { workspaceId: 'w', cwd: '/work', hostId: 'host', conversationId: 'monitor' };
  assert.equal(isTaskOwnedBy({ owner }, owner), true);
  assert.equal(isTaskOwnedBy({ owner: { ...owner, cwd: '/moved' } }, owner), false);
  assert.equal(isTaskOwnedBy({ owner: { ...owner, conversationId: 'other' } }, owner), false);
  assert.equal(isTaskOwnedBy({ owner: { ...owner, hostId: 'other' } }, owner), false);
});

test('task status and absent usage are rendered explicitly', () => {
  assert.equal(taskStatusLabel('ready_for_review'), 'Ready for review');
  assert.equal(taskStatusLabel('needs_you'), 'Needs you');
  assert.equal(taskUsageLabel(undefined), 'Usage: Unknown');
  assert.equal(taskUsageLabel({ inputTokens: 120, outputTokens: 30, costMicros: null }), 'Usage: 120 in · 30 out · cost Unknown');
});

test('uncertain request retry retains the original durable request id and payload', () => {
  const pending = { requestId: 'req-1', text: 'Fix the parser', destination: { threadId: 'thread-a', newThread: false, workers: ['claude'] } };
  assert.equal(retainRequestForRetry(pending), pending);
});

test('task cards link to the parent and execution threads without duplicates', () => {
  const task = { parentThreadId: 'parent', executionThreadId: 'worker' };
  assert.deepEqual(taskThreadLinks(task), [{ id: 'parent', label: 'Parent thread' }, { id: 'worker', label: 'Linked worker chat' }]);
  assert.deepEqual(taskThreadLinks({ ...task, executionThreadId: 'parent' }), [{ id: 'parent', label: 'Parent thread' }]);
});


test('task snapshots reject wrong workspace and malformed owner bindings without replacing valid state', () => {
  const owner = { workspaceId: 'w', cwd: '/work', hostId: 'host', conversationId: 'monitor' };
  const task = { workspaceId: owner.workspaceId, owner };
  const snapshot = { workspaceId: 'w', revision: 1, tasks: [task], executions: [] };
  assert.equal(isSnapshotForOwner(snapshot, owner), true);
  assert.equal(isSnapshotForOwner({ ...snapshot, tasks: [{ workspaceId: owner.workspaceId, owner: { ...owner, hostId: 'other' } }] }, owner), false);
  assert.equal(isSnapshotForOwner({ ...snapshot, workspaceId: 'other' }, owner), false);
  const oldMonitorTask = { workspaceId: owner.workspaceId, owner: { ...owner, conversationId: 'previous-monitor' } };
  assert.deepEqual(assistantTasksForOwner({ ...snapshot, tasks: [task, oldMonitorTask] }, owner), [task]);
  assert.throws(() => assistantTasksForOwner({ ...snapshot, tasks: [{ workspaceId: owner.workspaceId, owner: { ...owner, hostId: 'other' } }] }, owner), /different project folder or machine/);
});

test('conversation requests bind one explicit destination and exact thread labels to the durable request', async () => {
  const { assistantMessageArgs } = await import('../src/assistantTaskModel.ts');
  const owner = { workspaceId: 'w', cwd: '/work', hostId: 'host', conversationId: 'monitor' };
  const pending = { requestId: 'req-1', text: 'Fix it', owner, destination: { threadId: 'chat-a', workers: ['claude'], newThread: false }, newWorkerProfiles: [], mode: 'in_place', checks: [['npm', 'test']], threadLabels: [{ id: 'chat-a', label: 'Original label' }] };
  assert.deepEqual(assistantMessageArgs(owner, pending, [{ id: 'chat-a', label: 'Build room' }]), {
    ...owner, requestId: 'req-1', text: 'Fix it', destination: pending.destination, newWorkerProfiles: [], checks: [['npm', 'test']],
    threadLabels: [{ id: 'chat-a', label: 'Original label' }], mode: 'in_place',
    workerProfiles: [], spendLimitMicros: null,
  });
  assert.deepEqual(assistantMessageArgs(owner, { ...pending, threadLabels: undefined }, [{ id: 'chat-a', label: 'Build room' }]).threadLabels, [{ id: 'chat-a', label: 'Build room' }], 'older pending records use provided current labels');
  assert.equal(assistantMessageArgs(owner, { ...pending, destination: null, mode: 'isolated' }, []).destination, null);
  assert.throws(() => assistantMessageArgs({ ...owner, cwd: '/elsewhere' }, pending, []), /different assignment/);
});

test('read-only recovery retains the selected worker catalogue and original spend cap', () => {
  const owner = { workspaceId: 'w', cwd: '/work', hostId: 'host', conversationId: 'monitor' };
  const worker = { id: 'luna', display_name: 'Luna', backend: { kind: 'agent', tool: 'codex' } };
  const pending = { requestId: 'read-request', text: 'Ask Luna to review the chats', owner, destination: null, newWorkerProfiles: [], workerProfiles: [worker], mode: 'read_only', checks: [], spendLimitMicros: 500_000 };
  const stored = new Map();
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  savePendingRequest(storage, pending, owner);
  const recovered = loadPendingRequest(storage, owner);
  assert.equal(recovered.mode, 'read_only');
  assert.deepEqual(assistantMessageArgs(owner, recovered, []).workerProfiles, [worker]);
  assert.equal(assistantMessageArgs(owner, recovered, []).spendLimitMicros, 500_000);
});

test('uncertain request storage is scoped to the exact owner and can be explicitly cleared', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const owner = { workspaceId: 'w', cwd: '/work', hostId: 'host', conversationId: 'monitor' };
  const pending = { requestId: 'req', text: 'Fix', owner, destination: null, newWorkerProfiles: [], mode: 'isolated', checks: [['npm', 'test']] };
  savePendingRequest(storage, pending, owner);
  assert.equal(loadPendingRequest(storage, owner).requestId, 'req');
  assert.equal(loadPendingRequest(storage, { ...owner, hostId: 'other' }), null);
  assert.throws(() => savePendingRequest(storage, pending, { ...owner, conversationId: 'other' }), /different assignment/);
  clearPendingRequest(storage, owner); assert.equal(values.has(pendingRequestStorageKey(owner)), false);
});

test('task actions carry the loaded task revision and owner for compare-and-set', async () => {
  const { assistantTaskActionArgs } = await import('../src/assistantTaskModel.ts');
  const task = { id: 'task-1', revision: 4, mode: 'isolated', owner: { workspaceId: 'w', cwd: '/work', hostId: 'host', conversationId: 'monitor' } };
  assert.deepEqual(assistantTaskActionArgs(task, 'request_changes', { text: 'Please fix the test.' }), {
    taskId: 'task-1', revision: 4, owner: task.owner, action: 'request_changes', mode: 'isolated', text: 'Please fix the test.',
  });
  assert.equal(assistantTaskActionArgs(task, 'accept').mode, 'isolated', 'Acceptance requires the isolated-host capability too.');
});

test('new task worker choices stay separate from the restricted ApexAgent profile choices', () => {
  assert.deepEqual(taskWorkerChoices(profiles).map(profile => profile.id), ['http', 'claude', 'codex', 'grok', 'gemini', 'cli']);
});

test('archive state comes from durable markers or tombstoned execution records', () => {
  const task = { id: 'archived', resultData: { archivedAtMs: 50 } };
  const snapshot = { tasks: [task], executions: [{ taskId: 'pane-archived', tombstonedAtMs: 5 }, { taskId: 'live', tombstonedAtMs: null }] };
  assert.deepEqual([...archivedTaskIds(snapshot)].sort(), ['archived', 'pane-archived']);
});

test('reconcile requires an isolated integration with both saved plan and journal', () => {
  const task = { mode: 'isolated', status: 'interrupted', resultData: { integrationPlan: {}, applyJournal: '/tmp/journal' } };
  assert.equal(canReconcileTask(task), true);
  assert.equal(canReconcileTask({ ...task, status: 'failed' }), false);
  assert.equal(canReconcileTask({ ...task, mode: 'in_place' }), false);
  assert.equal(canReconcileTask({ ...task, resultData: { integrationPlan: {} } }), false);
});

test('old terminal isolated worktrees get an archive suggestion after fourteen days', () => {
  const now = 30 * 24 * 60 * 60 * 1000;
  assert.equal(shouldSuggestArchive({ mode: 'isolated', status: 'done', updatedAtMs: now - 15 * 24 * 60 * 60 * 1000, resultData: {} }, now), true);
  assert.equal(shouldSuggestArchive({ mode: 'isolated', status: 'done', updatedAtMs: now - 13 * 24 * 60 * 60 * 1000, resultData: {} }, now), false);
  assert.equal(shouldSuggestArchive({ mode: 'isolated', status: 'done', updatedAtMs: 0, resultData: { archivedAtMs: 1 } }, now), false);
});

test('handoff retries retain the exact payload and reject another assignment', async () => {
  const { handoffPreparationArgs } = await import('../src/assistantTaskModel.ts');
  const owner = { workspaceId: 'a', hostId: 'local', cwd: '/a', conversationId: 'one' };
  const child = { payload: { requestId: 'batch:0', batchId: 'batch', owner, revision: 3, originalRequest: 'Ask Null', brief: 'Fix login', destination: { threadId: 'chat', workers: ['null'], newThread: false }, mode: 'isolated', reviewCriteria: [] } };
  assert.equal(handoffPreparationArgs(child, owner), child.payload);
  for (const changed of [{ workspaceId: 'b' }, { cwd: '/b' }, { hostId: 'remote' }, { conversationId: 'two' }]) assert.throws(() => handoffPreparationArgs(child, { ...owner, ...changed }), /assignment changed/);
});
