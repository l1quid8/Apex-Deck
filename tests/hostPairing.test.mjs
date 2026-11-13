import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairedHost, createHostPairing } from '../desktop/hostPairing.mjs';

const made = { hostEndpointId: 'a'.repeat(64), addrs: [], name: 'Studio', hostId: 'daemon-1', tier: 'chat' };
test('paired hosts retain transport and identity across save/load, without invitation secrets', async () => {
  const { loadHosts, saveHosts } = await import('../desktop/hosts.mjs');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paired-host-'));
  try {
    const host = pairedHost(made, [], 'daemon-1');
    saveHosts(path.join(dir, 'hosts.json'), { hosts: [host] });
    assert.deepEqual(loadHosts(path.join(dir, 'hosts.json')).state.hosts, [host]);
    assert.equal(host.transport, 'paired'); assert.equal(host.ssh, undefined);
    assert.throws(() => pairedHost(made, [host], 'daemon-1'), /already/);
    assert.throws(() => pairedHost(made, [], 'other'), /identity/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('approval is verified before saving and cancellation prevents late saves', async () => {
  let emit, saved = 0, verify;
  const pairing = createHostPairing({
    open: (_link, cb) => { emit = cb; return { close() {} }; },
    verify: () => new Promise(resolve => { verify = resolve; }),
    save: () => { saved++; return []; },
  });
  pairing.start('invitation');
  emit({ type: 'pairCode', code: '123456', hostName: 'Studio' });
  assert.equal(pairing.status().kind, 'code'); assert.equal(saved, 0);
  emit({ type: 'pairDone', ...made });
  await Promise.resolve(); pairing.cancel(); verify('daemon-1');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved, 0); assert.equal(pairing.status().kind, 'idle');
});
test('denial never saves a host', () => {
  let emit;
  const pairing = createHostPairing({ open: (_link, cb) => { emit = cb; return { close() {} }; }, verify() { assert.fail(); }, save() { assert.fail(); } });
  pairing.start('invitation'); emit({ type: 'closed', code: 14, reason: 'denied' });
  assert.match(pairing.status().message, /denied/);
});
test('approval saves only after a verified hello and ignores stale events', async () => {
  let emit, saved = 0;
  const pairing = createHostPairing({ open: (_link, cb) => { emit = cb; return { close() {} }; }, verify: async () => 'daemon-1', save: (event, id) => { saved++; return [pairedHost(event, [], id)]; } });
  pairing.start('invitation'); emit({ type: 'pairDone', ...made });
  assert.equal(saved, 0);
  emit({ type: 'pairCode', code: 'stale' });
  assert.equal(pairing.status().kind, 'verifying');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pairing.status().kind, 'done'); assert.equal(saved, 1);
  emit({ type: 'pairDone', ...made }); assert.equal(saved, 1);
});
test('failed verification never persists the approved host', async () => {
  let emit;
  const pairing = createHostPairing({ open: (_link, cb) => { emit = cb; return { close() {} }; }, verify: async () => { throw Error('wrong daemon identity'); }, save: () => assert.fail('must not save') });
  pairing.start('invitation'); emit({ type: 'pairDone', ...made });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pairing.status().kind, 'failed'); assert.match(pairing.status().message, /identity/);
});
