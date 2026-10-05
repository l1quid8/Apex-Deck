import test from 'node:test';
import assert from 'node:assert/strict';
import { actionChevron } from '../src/messageActions.ts';

test('human actions expand left and reverse when open', () => {
  assert.equal(actionChevron('human', false), '‹');
  assert.equal(actionChevron('human', true), '›');
});
test('model actions expand right and reverse when open', () => {
  assert.equal(actionChevron('bot', false), '›');
  assert.equal(actionChevron('bot', true), '‹');
});
