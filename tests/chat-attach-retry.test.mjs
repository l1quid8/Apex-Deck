import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../src/roomRecovery.ts');
const settle = () => new Promise(resolve => setImmediate(resolve));

test('an attached view keeps polling with backoff until the owner opens the room, with no reconnect', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0; let applied = 0;
  const misses = 4;
  const recovery = mod.createRoomRecovery({
    load: async () => { reads += 1; if (reads <= misses) throw new Error(mod.WAITING_FOR_OWNER); return { recovery_seq: 1 }; },
    apply: () => { applied += 1; retry.reset(); },
    fail: error => { if (mod.isWaitingForOwner(error)) retry.missed(); },
  });
  const retry = mod.createAttachRetry(() => { void recovery.refresh(); });
  await recovery.refresh();
  // 2s, 4s, then every 8s: each wait ends in exactly one more read.
  for (const [wait, after] of [[2000, 2], [4000, 3], [8000, 4], [8000, 5]]) {
    t.mock.timers.tick(wait - 1); await settle();
    assert.equal(reads, after - 1, `no read before ${wait}ms`);
    t.mock.timers.tick(1); await settle();
    assert.equal(reads, after, `read ${after} after ${wait}ms`);
  }
  assert.equal(applied, 1);
  assert.equal(recovery.pending(), false);
  // Once the room is read, the polling stops.
  t.mock.timers.tick(60000); await settle();
  assert.equal(reads, misses + 1);
});

test('closing the view cancels a pending poll and ignores later misses', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let tries = 0;
  const retry = mod.createAttachRetry(() => { tries += 1; });
  retry.missed();
  retry.dispose();
  retry.missed();
  t.mock.timers.tick(60000);
  assert.equal(tries, 0);
});
