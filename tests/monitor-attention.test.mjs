import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monitorAttentionKey,
  monitorAttentionSignal,
  withMonitorSnapshot,
  reconcileMonitorHost,
  monitorAttentionEntries,
  assistantTaskAttentionSignal,
} from '../src/monitorAttention.ts';
import { clearReady, seenFlags } from '../src/attention.ts';

function monitor(workspaceId, hostId = 'local', findings = [], extra = {}) {
  return {
    workspaceId, hostId, conversationId: 'conversation', cwd: '/project', profileId: 'profile',
    responsibility: '', nextStep: '', decisions: [], preferences: [], files: [], threads: [],
    paused: false, completed: false, revision: 1, messages: [], findings, activity: [],
    lastCheckedAt: null, nextCheckAt: null, wakeReason: null, evidenceFingerprint: null,
    activeCheck: null, error: null, ...extra,
  };
}

function finding(id, status = 'open', extra = {}) {
  return {
    id, summary: id, reason: '', confidence: 'observed', nextStep: '', evidence: [], status,
    firstSeenAt: 10, lastSeenAt: 20, lastNotifiedAt: 20, snoozedUntil: null, ...extra,
  };
}

test('host-style open findings with a future snooze stay quiet until the deadline', () => {
  const m = monitor('p', 'local', [finding('snoozed', 'open', { snoozedUntil: 200 })]);
  assert.equal(monitorAttentionSignal(m, 199), null);
  assert.equal(monitorAttentionSignal(m, 200).note, 'ApexAgent has 1 active blocker');
  assert.equal(m.findings[0].status, 'open', 'notification snooze never settles the finding');
});

test('attention belongs to the host and workspace, independent of pane flags', () => {
  const snapshot = monitor('project', 'local', [finding('blocker')]);
  const state = withMonitorSnapshot({}, 'project', 'local', snapshot, '/project');
  const paneFlags = { pane: { kind: 'needs_input', note: 'old', at: 1 } };
  assert.deepEqual(seenFlags(paneFlags, 'pane', false), {});
  assert.deepEqual(clearReady({ ...paneFlags, ready: { kind: 'done', note: 'ready', at: 2 } }), paneFlags);
  assert.equal(Object.keys(state).length, 1);
  assert.equal(monitorAttentionSignal(state[monitorAttentionKey('project', 'local', '/project')].monitor, 100).blocking, true);
});

test('signals only unresolved active blockers and remain stable across monitor lifecycle state', () => {
  const m = monitor('p', 'local', [
    finding('open'), finding('resolved', 'resolved'), finding('dismissed', 'dismissed'),
    finding('snoozed', 'snoozed', { snoozedUntil: 200 }),
  ], { paused: true, completed: true });
  assert.equal(monitorAttentionSignal(m, 199).note, 'ApexAgent has 1 active blocker');
  assert.deepEqual(monitorAttentionSignal(m, 200), {
    kind: 'needs_input', note: 'ApexAgent has 2 active blockers', at: 10, blocking: true,
  });
  assert.equal(monitorAttentionSignal(monitor('p', 'local', [finding('old', 'open', { firstSeenAt: 0, lastSeenAt: 42 })]), 100).at, 42);
  assert.equal(monitorAttentionSignal(monitor('p', 'local', [finding('snoozed', 'snoozed', { snoozedUntil: 99 })]), 100).at, 10);
});

test('snapshots survive reload-style reconciliation and clear only resolved owner keys', () => {
  let state = {};
  const workspaces = [{ id: 'a', hostId: 'local', path: '/project' }, { id: 'b', hostId: 'local', path: '/project' }];
  state = reconcileMonitorHost(state, 'local', [monitor('a', 'local', [finding('a1')]), monitor('b', 'local', [finding('b1')])], workspaces);
  const reloaded = structuredClone(state);
  state = reconcileMonitorHost(reloaded, 'local', [
    monitor('a', 'local', [finding('a1', 'resolved')]),
    monitor('b', 'local', [finding('b1')]),
  ], workspaces);
  assert.equal(monitorAttentionSignal(state[monitorAttentionKey('a', 'local', '/project')].monitor, 100), null);
  assert.equal(monitorAttentionSignal(state[monitorAttentionKey('b', 'local', '/project')].monitor, 100).blocking, true);
  assert.equal(state[monitorAttentionKey('b', 'local', '/project')].monitor.findings[0].id, 'b1');
});

test('same workspace IDs on different hosts stay independent', () => {
  let state = withMonitorSnapshot({}, 'p', 'local', monitor('p', 'local', [finding('local')]), '/project');
  state = withMonitorSnapshot(state, 'p', 'remote', monitor('p', 'remote', [finding('remote')]), '/project');
  state = withMonitorSnapshot(state, 'p', 'remote', null, '/project');
  assert.ok(state[monitorAttentionKey('p', 'local', '/project')]);
  assert.equal(state[monitorAttentionKey('p', 'remote', '/project')], undefined);
});

test('host reconciliation drops removed or moved workspace keys and preserves other hosts', () => {
  let state = {};
  state = withMonitorSnapshot(state, 'removed', 'local', monitor('removed', 'local', [finding('gone')]), '/project');
  state = withMonitorSnapshot(state, 'moved', 'local', monitor('moved', 'local', [finding('moved')]), '/project');
  state = withMonitorSnapshot(state, 'other', 'remote', monitor('other', 'remote', [finding('remote')]), '/project');
  state = reconcileMonitorHost(state, 'local', [], [{ id: 'moved', hostId: 'remote' }]);
  assert.equal(state[monitorAttentionKey('removed', 'local', '/project')], undefined);
  assert.equal(state[monitorAttentionKey('moved', 'local', '/project')], undefined);
  assert.ok(state[monitorAttentionKey('other', 'remote', '/project')]);
});

test('visible entries require a listed, visible workspace on the matching host', () => {
  const state = withMonitorSnapshot({}, 'shown', 'local', monitor('shown', 'local', [finding('b')]), '/project');
  const entries = monitorAttentionEntries(state, [
    { id: 'shown', name: 'Shown', path: '/project' },
    { id: 'hidden', name: 'Hidden', path: '/hidden', hidden: true },
    { id: 'shown', name: 'Remote binding', path: '/remote', hostId: 'remote' },
  ], 100);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, monitorAttentionKey('shown', 'local', '/project'));
});

test('visible entries reject an embedded monitor workspace that differs from its binding', () => {
  const good = monitor('good', 'local', [finding('good-blocker')], { cwd: '/good' });
  const wrongWorkspace = monitor('other', 'local', [finding('wrong-workspace-blocker')], { cwd: '/project' });
  const state = {
    [monitorAttentionKey('good', 'local', '/good')]: { workspaceId: 'good', hostId: 'local', monitor: good },
    [monitorAttentionKey('project', 'local', '/project')]: { workspaceId: 'project', hostId: 'local', monitor: wrongWorkspace },
  };
  const entries = monitorAttentionEntries(state, [
    { id: 'good', path: '/good' },
    { id: 'project', path: '/project' },
  ], 100);
  assert.deepEqual(entries.map((entry) => entry.workspaceId), ['good']);
});

test('visible entries reject an embedded monitor host that differs from its binding', () => {
  const good = monitor('good', 'local', [finding('good-blocker')], { cwd: '/good' });
  const wrongHost = monitor('project', 'remote', [finding('wrong-host-blocker')], { cwd: '/project' });
  const state = {
    [monitorAttentionKey('good', 'local', '/good')]: { workspaceId: 'good', hostId: 'local', monitor: good },
    [monitorAttentionKey('project', 'local', '/project')]: { workspaceId: 'project', hostId: 'local', monitor: wrongHost },
  };
  const entries = monitorAttentionEntries(state, [
    { id: 'good', path: '/good' },
    { id: 'project', path: '/project' },
  ], 100);
  assert.deepEqual(entries.map((entry) => entry.workspaceId), ['good']);
});

test('visible entries reject an embedded monitor folder that differs from its binding', () => {
  const good = monitor('good', 'local', [finding('good-blocker')], { cwd: '/good' });
  const wrongFolder = monitor('project', 'local', [finding('wrong-folder-blocker')], { cwd: '/other' });
  const state = {
    [monitorAttentionKey('good', 'local', '/good')]: { workspaceId: 'good', hostId: 'local', monitor: good },
    [monitorAttentionKey('project', 'local', '/project')]: { workspaceId: 'project', hostId: 'local', monitor: wrongFolder },
  };
  const entries = monitorAttentionEntries(state, [
    { id: 'good', path: '/good' },
    { id: 'project', path: '/project' },
  ], 100);
  assert.deepEqual(entries.map((entry) => entry.workspaceId), ['good']);
});

test('mismatched snapshots cannot write or clear an owner key', () => {
  const original = withMonitorSnapshot({}, 'project', 'local', monitor('project', 'local', [finding('safe')]), '/project');
  assert.throws(() => withMonitorSnapshot(original, 'project', 'local', monitor('other', 'local'), '/project'), /workspace|host/i);
  assert.throws(() => withMonitorSnapshot(original, 'project', 'local', monitor('project', 'remote'), '/project'), /workspace|host/i);
  assert.deepEqual(reconcileMonitorHost(original, 'local', [monitor('project', 'remote')], [{ id: 'project', hostId: 'local', path: '/project' }]), original);
});

test('reusing a workspace ID for another folder keeps blocker ownership separate', () => {
  const oldMonitor = monitor('project', 'local', [finding('old')], { cwd: '/old' });
  const newMonitor = monitor('project', 'local', [finding('current')], { cwd: '/new' });
  let state = withMonitorSnapshot({}, 'project', 'local', oldMonitor, '/old');
  state = withMonitorSnapshot(state, 'project', 'local', newMonitor, '/new');
  assert.equal(Object.keys(state).length, 2);
  assert.deepEqual(monitorAttentionEntries(state, [{ id: 'project', hostId: 'local', path: '/new' }], 100).map(entry => entry.monitor.findings[0].id), ['current']);
  state = withMonitorSnapshot(state, 'project', 'local', null, '/old');
  assert.equal(monitorAttentionEntries(state, [{ id: 'project', hostId: 'local', path: '/new' }], 100).length, 1);
});

test('a snapshot for a previous workspace folder cannot replace current blockers', () => {
  const current = monitor('project', 'local', [finding('current')], { cwd: '/new' });
  const state = withMonitorSnapshot({}, 'project', 'local', current, '/new');
  const stale = monitor('project', 'local', [], { cwd: '/old' });
  assert.throws(() => withMonitorSnapshot(state, 'project', 'local', stale, '/new'), /folder|cwd|owner/i);
  assert.equal(reconcileMonitorHost(state, 'local', [stale], [{ id: 'project', hostId: 'local', path: '/new' }]), state);
  assert.equal(monitorAttentionEntries(state, [{ id: 'project', hostId: 'local', path: '/old' }], 100).length, 0);
});

test('a delayed successful host snapshot cannot undo a newer human resolution', () => {
  const old = monitor('project', 'local', [finding('f')], { snapshotVersion: 8 });
  const settled = monitor('project', 'local', [finding('f', 'resolved')], { snapshotVersion: 9 });
  const state = withMonitorSnapshot({}, 'project', 'local', settled, '/project');
  assert.equal(withMonitorSnapshot(state, 'project', 'local', old, '/project'), state);
  const reconciled = reconcileMonitorHost(state, 'local', [old], [{ id: 'project', path: '/project' }]);
  assert.equal(monitorAttentionSignal(reconciled[monitorAttentionKey('project', 'local', '/project')].monitor, 100), null);
  const next = { ...old, snapshotVersion: 1, conversationId: 'new-assignment' };
  assert.equal(withMonitorSnapshot(state, 'project', 'local', next, '/project')[monitorAttentionKey('project', 'local', '/project')].monitor, next, 'a different assignment has its own version sequence');
});

test('task attention filters orphaned monitor owners and flags needs-you, failure, and review states', () => {
  const owner = { workspaceId: 'project', cwd: '/project', hostId: 'local', conversationId: 'current' };
  const task = (id, status, conversationId = owner.conversationId) => ({
    id, workspaceId: owner.workspaceId, owner: { ...owner, conversationId }, status,
    createdAtMs: 10, updatedAtMs: 20,
  });
  assert.equal(assistantTaskAttentionSignal([task('old', 'needs_you', 'old-monitor')], owner), null);
  assert.deepEqual(assistantTaskAttentionSignal([task('ask', 'needs_you')], owner), {
    kind: 'needs_input', note: '1 ApexAgent task need you', at: 20, blocking: true,
  });
  assert.equal(assistantTaskAttentionSignal([task('bad', 'failed')], owner).kind, 'failed');
  assert.equal(assistantTaskAttentionSignal([task('review', 'ready_for_review')], owner).kind, 'done');
  assert.throws(() => assistantTaskAttentionSignal([task('wrong-host', 'needs_you')].map(item => ({ ...item, owner: { ...owner, hostId: 'other' } })), owner), /does not match its owner/);
});
