import test from 'node:test';
import assert from 'node:assert/strict';
import { foldsMessageActions, handOffChoices, handOffLabel, quoteFor, quoteLead, replyText } from '../src/reply.ts';

test('quote replies address the selected model and preserve multiline context', () => {
  assert.equal(replyText('Thanks', { id: 'null', name: 'Null', text: 'First\n\nSecond' }), '@null Thanks\n\n> Null wrote:\n> First\n> \n> Second');
});

test('handles inside a quote cannot summon other models', () => {
  const result = replyText('Yes', { id: 'jigga', name: 'Jigga', text: 'Ask @null or @all' });
  assert.ok(result.startsWith('@jigga Yes'));
  assert.ok(!result.includes('@null'));
  assert.ok(!result.includes('@all'));
});

test('ordinary messages keep their existing behavior', () => {
  assert.equal(replyText('  Hello @all  ', null), 'Hello @all');
});

test('your own @mention means the quote adds no handle', () => {
  const quote = { id: 'jigga', name: 'Jigga', text: 'Use a cache.' };
  assert.equal(replyText('@null check this', quote, ['jigga', 'null']), '@null check this\n\n> Jigga wrote:\n> Use a cache.');
  assert.ok(replyText('@all thoughts?', quote, ['jigga', 'null']).startsWith('@all thoughts?'));
});

test('a mention inside the quoted text is not yours', () => {
  const quote = { id: 'jigga', name: 'Jigga', text: 'Ask @null about it' };
  assert.ok(replyText('Agreed?', quote, ['jigga', 'null']).startsWith('@jigga Agreed?'));
});

test('Send to sets the leading handle', () => {
  const quote = { id: 'jigga', name: 'Jigga', text: 'Use a cache.', to: 'null' };
  assert.ok(replyText('Check this', quote, ['jigga', 'null']).startsWith('@null Check this'));
  assert.ok(replyText('Check this', { ...quote, to: 'all' }, ['jigga', 'null']).startsWith('@all Check this'));
  assert.equal(quoteLead('Check this', quote, ['jigga', 'null']), 'null');
});

test('your own messages can be quoted and lead with nobody by default', () => {
  const quote = quoteFor({ seq: 4, speaker: { kind: 'human' }, text: 'Ship it' }, (id) => id);
  assert.deepEqual(quote, { id: '', name: 'I', text: 'Ship it' });
  assert.equal(replyText('Still true?', quote, ['null']), 'Still true?\n\n> I wrote:\n> Ship it');
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

test('message actions fold into one menu in a pane under 360px wide', () => {
  assert.equal(foldsMessageActions(359), true);
  assert.equal(foldsMessageActions(360), false);
});
