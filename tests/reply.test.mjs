import test from 'node:test';
import assert from 'node:assert/strict';
import { handOffChoices, handOffLabel, quoteFor, quoteLead, quoteTarget, replyText } from '../src/reply.ts';

const bots = (...ids) => ids.map((id) => ({ id, display_name: id }));

test('quote replies address the selected model and preserve multiline context', () => {
  assert.equal(replyText('Thanks', { id: 'null', name: 'Null', text: 'First\n\nSecond' }, bots('null')), '@null Thanks\n\n> Null wrote:\n> First\n> \n> Second');
});

test('handles inside a quote cannot summon other models', () => {
  const result = replyText('Yes', { id: 'jigga', name: 'Jigga', text: 'Ask @null or @all' }, bots('jigga', 'null'));
  assert.ok(result.startsWith('@jigga Yes'));
  assert.ok(!result.includes('@null'));
  assert.ok(!result.includes('@all'));
});

test('ordinary messages keep their existing behavior', () => {
  assert.equal(replyText('  Hello @all  ', null, bots('null')), 'Hello @all');
});

test('your own @mention means the quote adds no handle', () => {
  const quote = { id: 'jigga', name: 'Jigga', text: 'Use a cache.' };
  assert.equal(replyText('@null check this', quote, bots('jigga', 'null')), '@null check this\n\n> Jigga wrote:\n> Use a cache.');
  assert.ok(replyText('@all thoughts?', quote, bots('jigga', 'null')).startsWith('@all thoughts?'));
});

test('a mention inside the quoted text is not yours', () => {
  const quote = { id: 'jigga', name: 'Jigga', text: 'Ask @null about it' };
  assert.ok(replyText('Agreed?', quote, bots('jigga', 'null')).startsWith('@jigga Agreed?'));
});

test('Send to sets the leading handle', () => {
  const quote = { id: 'jigga', name: 'Jigga', text: 'Use a cache.', to: 'null' };
  assert.ok(replyText('Check this', quote, bots('jigga', 'null')).startsWith('@null Check this'));
  assert.ok(replyText('Check this', { ...quote, to: 'all' }, bots('jigga', 'null')).startsWith('@all Check this'));
  assert.equal(quoteLead('Check this', quote, bots('jigga', 'null')), 'null');
});

test('a quote of a renamed bot leads with its new name, even when another bot took the old one', () => {
  const people = [{ id: 'jigga', display_name: 'Atlas' }, { id: 'jigga-2', display_name: 'Jigga' }];
  const quote = { id: 'jigga', name: 'Atlas', text: 'Use a cache.' };
  assert.ok(replyText('Agreed?', quote, people).startsWith('@atlas Agreed?'));
  assert.ok(replyText('Check', { ...quote, to: 'jigga-2' }, people).startsWith('@jigga Check'));
  assert.equal(replyText('@atlas check this', quote, people), '@atlas check this\n\n> Atlas wrote:\n> Use a cache.', 'your own mention by the new name counts');
});

test('a quote of a bot that has left the chat leads with nobody, not with its old handle', () => {
  const quote = { id: 'gone', name: 'Gone', text: 'Bye' };
  assert.equal(replyText('Agreed?', quote, bots('null')), 'Agreed?\n\n> Gone wrote:\n> Bye');
  assert.equal(quoteTarget('Agreed?', [quote], bots('null')), null, 'and the Send to button agrees');
  assert.equal(replyText('Agreed?', { ...quote, to: 'gone' }, bots('null')), 'Agreed?\n\n> Gone wrote:\n> Bye', 'nor does a Send to picked before it left');
});

test('your own messages can be quoted and lead with nobody by default', () => {
  const quote = quoteFor({ seq: 4, speaker: { kind: 'human' }, text: 'Ship it' }, (id) => id);
  assert.deepEqual(quote, { id: '', name: 'I', text: 'Ship it' });
  assert.equal(replyText('Still true?', quote, bots('null')), 'Still true?\n\n> I wrote:\n> Ship it');
  assert.deepEqual(quoteFor({ seq: 5, speaker: { kind: 'bot', id: 'null' }, text: 'Done' }, () => 'Null'), { id: 'null', name: 'Null', text: 'Done' });
});

test('the hand-off menu lists the other bots and Everyone', () => {
  const bots = [{ id: 'jigga', name: 'Jigga' }, { id: 'null', name: 'Null' }];
  assert.deepEqual(handOffChoices('jigga', bots), [{ to: 'null', label: 'Null' }, { to: 'all', label: 'Everyone' }]);
  assert.deepEqual(handOffChoices('all', bots), [{ to: 'jigga', label: 'Jigga' }, { to: 'null', label: 'Null' }]);
  assert.equal(handOffLabel('null', (id) => (id === 'null' ? 'Null' : id)), 'Send to Null');
  assert.equal(handOffLabel('all', (id) => id), 'Send to everyone');
  assert.equal(handOffLabel(null, (id) => id), 'Send to…');
});

test('multiple Add to chat quotes stack instead of overwriting', () => {
  const quotes = [
    { id: 'null', name: 'Null', text: 'First' },
    { id: 'jigga', name: 'Jigga', text: 'Second' },
  ];
  assert.equal(
    replyText('Thanks', quotes, bots('null', 'jigga')),
    '@null Thanks\n\n> Null wrote:\n> First\n> \n> Jigga wrote:\n> Second',
  );
});

test('an explicit Send to wins across stacked quotes', () => {
  const quotes = [
    { id: 'null', name: 'Null', text: 'First' },
    { id: 'jigga', name: 'Jigga', text: 'Second', to: 'all' },
  ];
  assert.ok(replyText('Check', quotes, bots('null', 'jigga')).startsWith('@all Check'));
});

test('preview and send agree when your own quote comes first', () => {
  const quotes = [
    { id: '', name: 'I', text: 'Mine' },
    { id: 'muck', name: 'Muck', text: 'Hi' },
  ];
  assert.equal(quoteTarget('', quotes, bots('muck', 'null')), 'muck');
  assert.ok(replyText('', quotes, bots('muck', 'null')).startsWith('@muck '));
});
