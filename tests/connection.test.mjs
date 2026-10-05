import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionStore, statusWords } from '../src/connection.ts';

test('status words name the host and count down to the next try', () => {
  assert.equal(statusWords({ kind: 'connecting' }, 'This Mac', 0), 'Connecting to This Mac…');
  assert.equal(statusWords({ kind: 'connected', hostId: 'h' }, 'vps', 0), 'Connected to vps.');
  assert.equal(statusWords({ kind: 'reconnecting', attempt: 3, reason: 'x', retryAt: 5000 }, 'vps', 1200), 'Reconnecting to vps… next try in 4 s');
  assert.equal(statusWords({ kind: 'reconnecting', attempt: 3, reason: 'x', retryAt: 5000 }, 'vps', 5000), 'Reconnecting to vps… trying now');
  assert.equal(statusWords({ kind: 'resync' }, 'vps', 0), 'Catching up with vps…');
  assert.equal(statusWords({ kind: 'failed', reason: 'The host speaks protocol 2.' }, 'vps', 0), "Can't connect to vps. The host speaks protocol 2.");
});

test('the store tells subscribers about each change until they leave', () => {
  const store = connectionStore();
  assert.deepEqual(store.get(), { status: { kind: 'connecting' }, host: 'This Mac' });
  const seen = [];
  const off = store.subscribe(() => seen.push(store.get()));
  store.setHost('vps');
  store.setStatus({ kind: 'connected', hostId: 'h' });
  off();
  store.setStatus({ kind: 'resync' });
  assert.deepEqual(seen, [
    { status: { kind: 'connecting' }, host: 'vps' },
    { status: { kind: 'connected', hostId: 'h' }, host: 'vps' },
  ]);
});
