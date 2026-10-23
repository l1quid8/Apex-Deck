import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantStatus, assistantWorkItems, delegatedTasksForAssistant, accessLabel } from '../src/assistantStatus.ts';

const ref = { hostId: 'mac', assistantId: 'a1' };
const project = { hostId: 'mac', workspaceId: 'w1', cwd: '/repo' };
const personal = (status, extra = {}) => ({ id: `p-${status}`, goal: `Personal ${status}`, completionCriteria: [], targetHost: 'mac', status, receipts: [], updatedAt: 10, ...extra });
const delegated = (status, extra = {}) => ({ id: `d-${status}`, status, originalRequest: `Delegated ${status}\nmore`, workers: ['hyke'], updatedAtMs: 20, lineage: { assistant: ref, project, sourceEventId: 'e', delegationId: 'x' }, ...extra });
const base = { offline: false, paused: false, personalTasks: [], delegatedTasks: [] };

test('status counts personal and delegated together', () => {
  const status = assistantStatus({ ...base, personalTasks: [personal('needsYou')], delegatedTasks: [delegated('ready_for_review')] });
  assert.deepEqual(status, { state: 'needs_you', needsYou: 2, failed: 0, working: 0, label: 'Needs you · 2' });
});

test('needs you outranks failed, failed outranks working', () => {
  assert.equal(assistantStatus({ ...base, personalTasks: [personal('failed'), personal('needsYou')] }).state, 'needs_you');
  const failed = assistantStatus({ ...base, delegatedTasks: [delegated('interrupted'), delegated('running')] });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.label, 'Failed · 1');
  assert.equal(failed.working, 1);
});

test('working counts queued, waiting and applying', () => {
  const status = assistantStatus({ ...base, personalTasks: [personal('queued'), personal('waiting')], delegatedTasks: [delegated('applying')] });
  assert.equal(status.state, 'working');
  assert.equal(status.label, 'Working · 3');
});

test('offline wins but lists keep items', () => {
  const input = { ...base, offline: true, paused: true, personalTasks: [personal('needsYou')] };
  const status = assistantStatus(input);
  assert.equal(status.state, 'offline');
  assert.equal(status.label, 'Offline');
  assert.equal(status.needsYou, 1);
  assert.equal(assistantWorkItems(input.personalTasks, [], () => '').needsYou.length, 1);
});

test('paused assistant says Paused', () => {
  assert.equal(assistantStatus({ ...base, paused: true, personalTasks: [personal('running')] }).label, 'Paused');
});

test('paused delegated task is not working', () => {
  const status = assistantStatus({ ...base, delegatedTasks: [delegated('running', { desiredState: 'paused' })] });
  assert.equal(status.working, 0);
  assert.equal(status.state, 'ready');
});

test('ready has label Ready', () => {
  assert.equal(assistantStatus({ ...base, personalTasks: [personal('done')] }).label, 'Ready');
});

test('work items split, title, project name and newest first', () => {
  const items = assistantWorkItems(
    [personal('needsYou', { updatedAt: 5 }), personal('done'), personal('cancelled')],
    [delegated('ready_for_review', { updatedAtMs: 50 }), delegated('running'), delegated('failed'), delegated('cancelled')],
    p => (p.cwd === '/repo' ? 'repo' : '?'),
  );
  assert.deepEqual(items.needsYou.map(i => i.taskId), ['d-ready_for_review', 'd-failed', 'p-needsYou']);
  assert.equal(items.needsYou[0].title, 'Delegated ready_for_review');
  assert.equal(items.needsYou[0].projectName, 'repo');
  assert.equal(items.needsYou[0].worker, 'hyke');
  assert.equal(items.needsYou[0].source, 'delegated');
  assert.deepEqual(items.working.map(i => i.taskId), ['d-running']);
  assert.deepEqual(items.finished.map(i => i.taskId), ['p-done']);
  assert.equal(items.cancelled.length, 2);
});

test('delegatedTasksForAssistant keeps only assigned projects of this assistant', () => {
  const owners = { o: { snapshot: { tasks: [delegated('running'), delegated('done', { id: 'other-cwd', lineage: { assistant: ref, project: { ...project, cwd: '/elsewhere' }, sourceEventId: 'e', delegationId: 'y' } }), delegated('done', { id: 'other-assistant', lineage: { assistant: { hostId: 'mac', assistantId: 'a2' }, project, sourceEventId: 'e', delegationId: 'z' } })] } }, empty: {} };
  assert.deepEqual(delegatedTasksForAssistant(owners, ref, [{ project, tools: 'ask' }]).map(t => t.id), ['d-running']);
});

test('accessLabel matches agent card copy', () => {
  assert.deepEqual(['ask', 'full', 'read', 'edits'].map(accessLabel), ['Asks first', 'Full access', 'Read only', 'Can edit files']);
});
