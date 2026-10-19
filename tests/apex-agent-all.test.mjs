import test from 'node:test';
import assert from 'node:assert/strict';
import { laneMentions, mentionedLane, mentionsAll, mergeProjectConversations, replyTarget, withoutLaneMentions } from '../src/apexAgentModel.ts';

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

test('a project answers to its name after @, or to its id when another project has that name or it means everyone', () => {
  const lanes = [{ id: 'ws-1', name: 'Mobile' }, { id: 'ws-2', name: 'Mobile' }, { id: 'ws-3', name: 'All' }, { id: 'ws-4', name: 'Billing API' }];
  assert.deepEqual([...laneMentions(lanes)], [['ws-1', 'ws-1'], ['ws-2', 'ws-2'], ['ws-3', 'ws-3'], ['ws-4', 'billing-api']]);
  assert.equal(mentionedLane('is @billing-api. done?', lanes), 'ws-4', 'a full stop after it is punctuation');
  assert.equal(mentionedLane('@billing-apis status', lanes), null, 'a longer word is another word');
  assert.equal(mentionedLane('@mobile status', lanes), null, 'a shared name picks neither');
  assert.equal(mentionedLane('mail me@billing-api.dev', lanes), null, 'an email address is no mention');
  assert.equal(mentionedLane('@ws-2 then @billing-api', lanes), 'ws-2', 'the first one named');
});

test('naming a project called "All Hands" does not mean every project', () => {
  const lanes = [{ id: 'ws-1', name: 'All Hands' }, { id: 'ws-2', name: 'Billing API' }];
  // Null's repro: @all-hands routed to every project because "@all" is its prefix.
  assert.equal(mentionedLane('@all-hands status?', lanes), 'ws-1');
  assert.equal(mentionsAll('@all-hands status?'), false, 'a project handle is not @all');
  assert.equal(mentionsAll('@all what now?'), true);
  assert.equal(mentionsAll('@all, what now?'), true);
  assert.equal(mentionsAll('@all.'), true, 'a full stop after it is punctuation');
  assert.equal(mentionsAll('@allsorts please'), false, 'a longer word is another word');
  assert.equal(mentionsAll('mail me@all.dev'), false, 'an email address is no mention');
  assert.equal(mentionsAll('no mention here'), false);
});

test('the every-project checks read a message with its project @names blanked out', () => {
  const lanes = [{ id: 'ws-1', name: 'All Hands' }, { id: 'ws-2', name: 'All' }, { id: 'ws-3', name: 'Overall' }];
  // Null's repros: the words inside @all-hands and @overall were read as other projects' names and as "overall".
  assert.equal(withoutLaneMentions('@all-hands status?', lanes), '  status?');
  assert.equal(withoutLaneMentions('ask @overall. then @ws-2', lanes), 'ask  . then  ', 'a full stop stays, and an id is a handle too');
  assert.equal(withoutLaneMentions('@all, then @Overall', lanes), '@all, then  ', '@all names no project; case does not matter');
  assert.equal(withoutLaneMentions('@jigga mail me@overall.dev', lanes), '@jigga mail me@overall.dev', 'a word naming no project, and an email address, stay');
});
