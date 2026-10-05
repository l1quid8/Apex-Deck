import test from 'node:test';
import assert from 'node:assert/strict';
import { actionChevron, messageTime } from '../src/messageActions.ts';

test('human actions expand left and reverse when open', () => {
  assert.equal(actionChevron('human', false), '‹');
  assert.equal(actionChevron('human', true), '›');
});
test('model actions expand right and reverse when open', () => {
  assert.equal(actionChevron('bot', false), '›');
  assert.equal(actionChevron('bot', true), '‹');
});

test('times in the last week name the weekday', () => {
  const now = new Date(2026, 9, 4, 12, 0).getTime();
  assert.equal(messageTime(new Date(2026, 9, 3, 3, 11).getTime(), now), 'Saturday 3:11 AM');
  assert.equal(messageTime(new Date(2026, 9, 4, 9, 5).getTime(), now), 'Sunday 9:05 AM');
  assert.equal(messageTime(new Date(2026, 8, 28, 0, 1).getTime(), now), 'Monday 12:01 AM');
});
test('older times give the full date', () => {
  const now = new Date(2026, 9, 11, 12, 0).getTime();
  assert.equal(messageTime(new Date(2026, 9, 3, 3, 11).getTime(), now), 'October 3rd, 2026 @ 3:11 AM');
  assert.equal(messageTime(new Date(2026, 9, 4, 15, 30).getTime(), now), 'October 4th, 2026 @ 3:30 PM');
  assert.equal(messageTime(new Date(2026, 0, 1, 8, 0).getTime(), now), 'January 1st, 2026 @ 8:00 AM');
  assert.equal(messageTime(new Date(2025, 10, 12, 8, 0).getTime(), now), 'November 12th, 2025 @ 8:00 AM');
  assert.equal(messageTime(new Date(2025, 10, 22, 8, 0).getTime(), now), 'November 22nd, 2025 @ 8:00 AM');
});
