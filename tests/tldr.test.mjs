import test from 'node:test';
import assert from 'node:assert/strict';
import { TLDR_LINE, splitTldr, withTldr } from '../src/tldr.ts';
import { carriedEntry, carriedFlag } from '../src/threadState.ts';

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

test('a draft or switch saved under a thread\'s old bare id moves to its machine-and-id key, once', () => {
  const key = JSON.stringify(['B', 'r1']);
  // Saved before keys named the machine: carried over rather than left behind.
  assert.deepEqual(carriedEntry({ r1: 'half a thought', other: 'x' }, key, 'r1'), { [key]: 'half a thought', other: 'x' });
  // A draft typed since the change is the one kept.
  assert.deepEqual(carriedEntry({ [key]: 'typed now', r1: 'old' }, key, 'r1'), { [key]: 'typed now', r1: 'old' });
  // Nothing to carry, or the same key, changes nothing.
  assert.deepEqual(carriedEntry({}, key, 'r1'), {});
  assert.deepEqual(carriedEntry({ r1: 'x' }, 'r1', 'r1'), { r1: 'x' });
  // A saved switch carries the same way, and the old key is cleared so it can't come back.
  const saved = new Map([['r1', '1']]);
  const read = (name) => saved.get(name) === '1';
  const write = (name, on) => { if (on) saved.set(name, '1'); else saved.delete(name); };
  assert.equal(carriedFlag(read, write, key, 'r1'), true);
  assert.equal(saved.has('r1'), false);
  assert.equal(saved.get(key), '1');
  assert.equal(carriedFlag(read, write, key, 'r1'), true);
  // Turned off after the change, it stays off: there is nothing left to carry.
  saved.delete(key);
  assert.equal(carriedFlag(read, write, key, 'r1'), false);
  assert.equal(saved.size, 0);
});
