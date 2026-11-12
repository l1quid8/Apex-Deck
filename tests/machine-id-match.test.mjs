// A server paired on the phone by QR code gets an id the phone makes up. The
// Mac files projects under its own id for that server. The Mac shares which
// daemon answers at each of its ids; the phone takes the Mac's id when the
// daemon it reached is the same one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { macHostIds } from '../src/hostSession.ts';
import { withMacHostIds, readHostIds } from '../src/phoneRules.ts';

const VPS_DAEMON = '7ff88be86c176058293925875184f51b';
const HOME_DAEMON = 'aaaabbbbccccddddeeeeffff00001111';
const EP = (c) => c.repeat(64);
const mac = { id: 'local', name: 'Mac', kind: 'mac', transport: 'iroh', hostEndpointId: EP('a'), addrs: [], pairedAt: 1 };
const vps = { id: 'h-7ff0aa112233', name: 'Apex-Terminal', kind: 'server', transport: 'iroh', hostEndpointId: EP('b'), addrs: [], pairedAt: 2 };
const home = { id: 'h-176ceff92c3d', name: 'STREAMVAULT', kind: 'server', transport: 'iroh', hostEndpointId: EP('c'), addrs: [], pairedAt: 3 };

test('the Mac shares only remote servers that have a daemon id', () => {
  assert.deepEqual(macHostIds([
    { id: 'local', name: 'Mac', remote: false, daemonHostId: 'x' },
    { id: 'h-muvo9af6fl17', name: 'Apex-Terminal', remote: true, daemonHostId: VPS_DAEMON },
    { id: 'h-old', name: 'Old', remote: true },
  ]), { 'h-muvo9af6fl17': VPS_DAEMON });
});

test('the phone reads only well-formed tables', () => {
  assert.deepEqual(readHostIds(undefined), {});
  assert.deepEqual(readHostIds(['x']), {});
  assert.deepEqual(readHostIds({ 'h-a': VPS_DAEMON, local: 'y', 'h-b': 3, '': 'z' }), { 'h-a': VPS_DAEMON });
});

test('a server the Mac knows by another id takes the Mac id', () => {
  const next = withMacHostIds([mac, vps, home], { 'h-muvo9af6fl17': VPS_DAEMON }, { [vps.id]: VPS_DAEMON, [home.id]: HOME_DAEMON });
  assert.deepEqual(next.map((m) => m.id), ['local', 'h-muvo9af6fl17', 'h-176ceff92c3d']);
  // Everything else about it stays.
  assert.deepEqual({ ...next[1], id: vps.id }, vps);
  assert.equal(next[2], home);
});

test('a different daemon never takes the id (home server is not the VPS)', () => {
  const list = [mac, home];
  assert.equal(withMacHostIds(list, { 'h-muvo9af6fl17': VPS_DAEMON }, { [home.id]: HOME_DAEMON }), list);
});

test('nothing changes when ids already match, the server is not connected, or the Mac id is taken', () => {
  const same = [mac, { ...vps, id: 'h-muvo9af6fl17' }];
  assert.equal(withMacHostIds(same, { 'h-muvo9af6fl17': VPS_DAEMON }, { 'h-muvo9af6fl17': VPS_DAEMON }), same);
  const offline = [mac, vps];
  assert.equal(withMacHostIds(offline, { 'h-muvo9af6fl17': VPS_DAEMON }, {}), offline);
  const taken = [mac, vps, { ...home, id: 'h-muvo9af6fl17' }];
  assert.equal(withMacHostIds(taken, { 'h-muvo9af6fl17': VPS_DAEMON }, { [vps.id]: VPS_DAEMON }), taken);
});

test('the phone Mac itself is never renamed', () => {
  const list = [mac];
  assert.equal(withMacHostIds(list, { 'h-x': 'macdaemon' }, { local: 'macdaemon' }), list);
});
