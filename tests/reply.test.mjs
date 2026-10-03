import test from 'node:test';
import assert from 'node:assert/strict';
import { replyText } from '../src/reply.ts';

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
