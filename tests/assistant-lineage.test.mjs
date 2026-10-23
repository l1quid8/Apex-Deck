import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingRequestStorageKey, taskBelongsToAssistant, taskControlLabel } from '../src/assistantTaskModel.ts';
const owner = { hostId:'host', workspaceId:'project', cwd:'/project', conversationId:'conversation' };
const a = { hostId:'host', assistantId:'a' };
const b = { hostId:'host', assistantId:'b' };
test('legacy keys are unchanged; delegated pending requests distinguish exact assistant', () => {
  assert.equal(pendingRequestStorageKey(owner), 'apex-agent-pending:project:%2Fproject:host:conversation');
  assert.notEqual(pendingRequestStorageKey(owner, a), pendingRequestStorageKey(owner, b));
  assert.notEqual(pendingRequestStorageKey(owner, a), pendingRequestStorageKey(owner, { ...a, hostId:'other' }));
});
test('selected assistant cannot claim legacy or another assistant task', () => {
  assert.equal(taskBelongsToAssistant({ owner }, a), false);
  const task = { owner, lineage: { assistant:a, project:{ hostId:'host', workspaceId:'project', cwd:'/project' }, sourceEventId:'event', delegationId:'delegation' } };
  assert.equal(taskBelongsToAssistant(task, a), true);
  assert.equal(taskBelongsToAssistant(task, b), false);
});
test('pause acknowledgement does not imply unsupported checkpoint recovery', () => {
  assert.equal(taskControlLabel({status:'running', desiredState:'paused'}), 'Pausing');
  assert.equal(taskControlLabel({status:'queued', desiredState:'paused'}), 'Paused');
  assert.equal(taskControlLabel({status:'interrupted', desiredState:'paused'}), 'Interrupted');
});

test('a finished spend-wait attempt is already at a verified pause boundary', () => {
  assert.equal(taskControlLabel({status:'needs_you',desiredState:'paused',attempts:[{finishedAtMs:10}]}),'Paused');
  assert.equal(taskControlLabel({status:'needs_you',desiredState:'paused',attempts:[{finishedAtMs:null}]}),'Pausing');
});
