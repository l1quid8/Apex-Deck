import test from 'node:test';
import assert from 'node:assert/strict';
import { TLDR_LINE, splitTldr, withTldr } from '../src/tldr.ts';

test('TL;DR mode adds the instruction and the chat hides it again', () => {
  const sent = withTldr('why is CI red?', true);
  assert.ok(sent.endsWith(TLDR_LINE));
  assert.deepEqual(splitTldr(sent), { text: 'why is CI red?', tldr: true });
});

test('off, or an empty message, sends the text untouched', () => {
  assert.equal(withTldr('hi', false), 'hi');
  assert.equal(withTldr('', true), '');
  assert.deepEqual(splitTldr('hi'), { text: 'hi', tldr: false });
});
