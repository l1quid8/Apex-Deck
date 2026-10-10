import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeProjectConversations, replyTarget } from '../src/apexAgentModel.ts';

const monitor = (workspaceId, messages) => ({ workspaceId, messages, findings: [] });
const msg = (id, at, text = id) => ({ id, role: 'assistant', text, at, evidence: [] });

test('every project joins one timeline in time order, tagged by project', () => {
  const merged = mergeProjectConversations([
    monitor('a', [msg('1', 10), msg('3', 30)]),
    monitor('b', [msg('2', 20)]),
  ], { a: 'Mobile launch', b: 'Billing API' });
  assert.deepEqual(merged.map((entry) => [entry.project, entry.message.id]), [['Mobile launch', '1'], ['Billing API', '2'], ['Mobile launch', '3']]);
});

test('same message id in two projects stays two entries', () => {
  const merged = mergeProjectConversations([monitor('a', [msg('m1', 1)]), monitor('b', [msg('m1', 1)])], {});
  assert.equal(merged.length, 2);
});

test('a reply goes to the project it names, longest name first', () => {
  const projects = [{ id: 'a', name: 'Mobile' }, { id: 'b', name: 'Mobile launch' }, { id: 'c', name: 'Billing API' }];
  assert.equal(replyTarget('How is billing api doing?', projects, 'a'), 'c');
  assert.equal(replyTarget('Keep mobile launch on Nov 1', projects, 'c'), 'b');
});

test('an unnamed reply continues the last project, else the first', () => {
  const projects = [{ id: 'a', name: 'Mobile' }, { id: 'b', name: 'Billing' }];
  assert.equal(replyTarget('Is SSO ready?', projects, 'b'), 'b');
  assert.equal(replyTarget('Is SSO ready?', projects, 'gone'), 'a');
  assert.equal(replyTarget('hi', [], 'a'), null);
});

test('a project name must be a whole word to redirect a reply', () => {
  const projects = [{ id: 'ui', name: 'UI' }, { id: 'billing', name: 'Billing API' }];
  assert.equal(replyTarget('Build the revised plan', projects, 'billing'), 'billing');
  assert.equal(replyTarget('How is the UI going?', projects, 'billing'), 'ui');
  assert.equal(replyTarget('Check C++ (v2) status', [{ id: 'c', name: 'C++ (v2)' }, { id: 'd', name: 'Docs' }], 'd'), 'c');
});
