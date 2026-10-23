import test from 'node:test';
import assert from 'node:assert/strict';
import { availableCount, exactDeadline, liveCredits, outcomeLine, secondsCountdown } from '../src/resetCredits.ts';

const credits = {
  available: 3,
  credits: [
    { id: 'late', granted_at: 0, expires_at: 2_000 },
    { id: 'forever', granted_at: 0 },
    { id: 'soon', granted_at: 0, expires_at: 1_000 },
  ],
};

test('usable credits come soonest to expire first, and expired ones drop out', () => {
  assert.deepEqual(liveCredits(credits, 500).map((c) => c.id), ['soon', 'late', 'forever']);
  assert.deepEqual(liveCredits(credits, 1_000).map((c) => c.id), ['late', 'forever']);
  assert.equal(availableCount(credits, 500), 3);
  assert.equal(availableCount(credits, 1_500), 2);
  assert.deepEqual(liveCredits(undefined, 0), []);
  assert.equal(availableCount(undefined, 0), 0);
});

test('the countdown runs to the second', () => {
  const at = 10_000;
  assert.equal(secondsCountdown(at + 6 * 86_400 + 13 * 3600 + 42 * 60 + 8, at), '6d 13h 42m 08s');
  assert.equal(secondsCountdown(at + 4 * 3600 + 5 * 60 + 9, at), '4h 05m 09s');
  assert.equal(secondsCountdown(at + 42 * 60 + 8, at), '42m 08s');
  assert.equal(secondsCountdown(at + 8.9, at), '8s');
  assert.equal(secondsCountdown(at - 5, at), '0s');
});

test('the exact deadline names the date, the second and the time zone', () => {
  const line = exactDeadline(1793302015, 'UTC');
  assert.match(line, /2026/);
  assert.match(line, /Oct 29/);
  assert.match(line, /7:26:55/);
  assert.match(line, /UTC/);
});

test('each outcome reads plainly, and only a missing credit is an error', () => {
  assert.deepEqual(outcomeLine('reset', 'Codex'), { text: 'Codex usage was reset. One reset credit was used.', tone: 'info' });
  assert.equal(outcomeLine('nothing_to_reset', 'Codex').tone, 'info');
  assert.equal(outcomeLine('no_credit', 'Codex').tone, 'error');
});
