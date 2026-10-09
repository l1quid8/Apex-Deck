import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantPaneForOwner, currentAssistantRegistry, emptyAssistantRegistry, mergeAssistantPanes, reduceAssistantSnapshot } from '../src/assistantRegistry.ts';

const owner = (conversationId = 'monitor-a') => ({ workspaceId: 'project', cwd: '/project', hostId: 'server-a', conversationId });
const pane = (id, extra = {}) => ({ id, workspaceId: 'project', kind: 'chat', title: id, participants: [], options: { policy: 'mention', max_bot_hops: 3 }, started: true, assistantTaskId: `task-${id}`, hostId: 'server-a', executionPath: `/work/${id}`, ...extra });
const execution = (id, tombstonedAtMs = null, descriptor = pane(id)) => ({ taskId: `task-${id}`, workspaceId: 'project', threadId: id, mode: 'isolated', tombstonedAtMs, ...(descriptor ? { pane: descriptor } : {}) });
const snapshot = (revision, executions) => ({ workspaceId: 'project', revision, tasks: [], executions });
const human = { id: 'human', workspaceId: 'project', kind: 'chat', title: 'Human thread' };

test('assistant panes merge into the view while unknown tombstones cannot hide human threads', () => {
  const state = reduceAssistantSnapshot(emptyAssistantRegistry(), owner(), snapshot(1, [execution('worker-a'), execution('human', 100, null)]));
  assert.deepEqual(mergeAssistantPanes([human], state), [human, pane('worker-a')]);
});

test('a registered child tombstone removes it and an older snapshot cannot restore it', () => {
  const first = reduceAssistantSnapshot(emptyAssistantRegistry(), owner(), snapshot(2, [execution('worker-a')]));
  const deleted = reduceAssistantSnapshot(first, owner(), snapshot(4, [execution('worker-a', 123, null), execution('unknown', 124, null)]));
  const stale = reduceAssistantSnapshot(deleted, owner(), snapshot(3, [execution('worker-a')]));
  assert.deepEqual(mergeAssistantPanes([human], stale), [human]);
});

test('the revision high-water mark is scoped to each project monitor owner', () => {
  let state = reduceAssistantSnapshot(emptyAssistantRegistry(), owner('monitor-a'), snapshot(8, [execution('worker-a')]));
  state = reduceAssistantSnapshot(state, owner('monitor-b'), snapshot(2, [execution('worker-b')]));
  state = reduceAssistantSnapshot(state, owner('monitor-a'), snapshot(7, [execution('worker-old')]));
  assert.deepEqual(mergeAssistantPanes([], state), [pane('worker-a'), pane('worker-b')]);
});

test('the desktop view drops descriptors after monitor conversation, host, or path changes', () => {
  let state = reduceAssistantSnapshot(emptyAssistantRegistry(), owner('monitor-a'), snapshot(8, [execution('worker-a')]));
  state = reduceAssistantSnapshot(state, owner('monitor-b'), snapshot(2, [execution('worker-b')]));
  assert.deepEqual(mergeAssistantPanes([], currentAssistantRegistry(state, { project: owner('monitor-b') })), [pane('worker-b')]);
  assert.deepEqual(mergeAssistantPanes([], currentAssistantRegistry(state, { project: { ...owner('monitor-b'), hostId: 'server-b' } })), []);
  assert.deepEqual(mergeAssistantPanes([], currentAssistantRegistry(state, { project: { ...owner('monitor-b'), cwd: '/moved' } })), []);
});

test('phone hides children on monitor removal and reassignment even when stale host events arrive later', () => {
  const savedHuman = [human];
  let state = reduceAssistantSnapshot(emptyAssistantRegistry(), owner('monitor-a'), snapshot(7, [execution('worker-a')]));
  assert.deepEqual(mergeAssistantPanes(savedHuman, currentAssistantRegistry(state, { project: owner('monitor-a') })), [human, pane('worker-a')]);

  // monitor_get returning null removes the current owner immediately.
  assert.deepEqual(mergeAssistantPanes(savedHuman, currentAssistantRegistry(state, {})), [human]);
  // A late event from the removed monitor may update its cache, but cannot make it visible.
  state = reduceAssistantSnapshot(state, owner('monitor-a'), snapshot(8, [execution('worker-a')]));
  assert.deepEqual(mergeAssistantPanes(savedHuman, currentAssistantRegistry(state, {})), [human]);

  state = reduceAssistantSnapshot(state, owner('monitor-b'), snapshot(1, [execution('worker-b')]));
  assert.deepEqual(mergeAssistantPanes(savedHuman, currentAssistantRegistry(state, { project: owner('monitor-b') })), [human, pane('worker-b')]);
  assert.equal(mergeAssistantPanes(savedHuman, currentAssistantRegistry(state, { project: { ...owner('monitor-b'), cwd: '/moved' } })).some((item) => item.id === 'worker-b'), false);
  assert.equal(assistantPaneForOwner(state, 'worker-b', { ...owner('monitor-b'), cwd: '/moved' }), null);
  assert.equal(assistantPaneForOwner(state, 'worker-a', owner('monitor-b')), null);
  assert.deepEqual(assistantPaneForOwner(state, 'worker-b', owner('monitor-b')), pane('worker-b'));
  state = reduceAssistantSnapshot(state, owner('monitor-a'), snapshot(9, [execution('worker-old')]));
  assert.deepEqual(mergeAssistantPanes(savedHuman, currentAssistantRegistry(state, { project: owner('monitor-b') })), [human, pane('worker-b')]);
  assert.deepEqual(savedHuman, [human], 'synthetic children never enter the human session pane array');
});
