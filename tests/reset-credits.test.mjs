import test from 'node:test';
import assert from 'node:assert/strict';
import { availableCount, exactDeadline, liveCredits, outcomeLine, clockCountdown, resetAsk } from '../src/resetCredits.ts';

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
  assert.equal(clockCountdown(at + 6 * 86_400 + 16 * 3600 + 15 * 60 + 42, at), '6d 16:15:42');
  assert.equal(clockCountdown(at + 4 * 3600 + 5 * 60 + 9, at), '04:05:09');
  assert.equal(clockCountdown(at + 8.9, at), '00:00:08');
  assert.equal(clockCountdown(at - 5, at), '00:00:00');
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

test('asking before a reset names the binding window, warns when barely used, and says what it spends', () => {
  const now = 10_000;
  const windows = [
    { name: 'five_hour', used_percent: 10, window_minutes: 300, resets_at: now + 3600 },
    { name: 'seven_day', used_percent: 20, window_minutes: 10_080, resets_at: now + 86_400 + 3600 },
  ];
  const ask = resetAsk(windows, { id: 'c', granted_at: 0, expires_at: now + 90 }, 'Codex', now);
  assert.deepEqual(ask.usage, { name: 'Weekly', used: 20, after: ', refills on its own in 1d 01:00:00.' });
  assert.equal(ask.barely, true);
  assert.equal(ask.spends, "Spends the credit that expires in 00:01:30. Can't be undone.");
  const full = resetAsk([{ name: 'primary', used_percent: 100, window_minutes: 10_080, resets_at: now + 60 }], null, 'Claude Code', now);
  assert.equal(full.usage.after, ", so you're blocked until it resets.");
  assert.equal(full.barely, false);
  assert.equal(full.spends, "Claude Code picks which credit to spend. Can't be undone.");
  assert.equal(resetAsk([], null, 'Codex', now).usage, null);
});
