import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Capacitor } from '@capacitor/core';
import { phoneShell } from '../src/phoneShell.ts';

// The phone no longer stops at a native prompt before a command: it sends it, and the machine says
// whether this device may do that (apex-daemon authority::access_effect). These tests sit at the real
// wire boundary — the real phone backend, the real command backend, the real daemon client — and count
// both what reached the wire and what reached native code, so "no prompt" is measured, not asserted
// from memory. Keep the real Capacitor proxy and one plugin header, as a paired phone has: the point is
// that nothing is asked of it.
Capacitor.PluginHeaders = [{ name: 'ApexSsh', methods: [{ name: 'authenticateBiometric', rtype: 'promise' }] }];
const { openPhoneHost } = await import('../src/phoneBackend.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
const machine = { id: 'bio-host', name: 'Test machine', kind: 'server', url: 'wss://example.test', token: 'token' };

async function connected(t) {
  const native = [];
  Capacitor.nativePromise = (plugin, method, options) => {
    native.push({ plugin, method, options });
    throw new Error('Nothing on the phone should ask for authentication any more.');
  };
  const sent = [];
  let hear;
  const host = openPhoneHost(machine, async () => ({
    send(text) {
      const frame = JSON.parse(text);
      sent.push(frame);
      if (frame.cmd !== 'hello') queueMicrotask(() => hear(JSON.stringify({ id: frame.id, ok: 'done' })));
    },
    onLine(cb) { hear = cb; }, onClose() {}, close() {},
  }), phoneShell({ machineName: machine.name }));
  t.after(() => host.close());
  const starting = host.start();
  await tick();
  hear(JSON.stringify({ id: sent[0].id, ok: { host_id: machine.id, boot_id: 'boot', protocol: 1, last_seq: 0, resumed: false, capabilities: ['monitor_watch_v1'] } }));
  await starting;
  sent.length = 0;
  return { backend: host.backend, sent, native };
}

// Every command the daemon treats as able to carry access, read from the daemon itself. Typed routes
// are exercised where the phone has one, because the guard and the typed method both end at the wire.
const raising = [
  ['room_add_participant', b => b.roomAddParticipant('room', { id: 'bot', access: 'full' })],
  ['room_update_participant', b => b.roomUpdateParticipant('room', { id: 'bot', access: 'full' })],
  ['room_create', b => b.roomCreate('room', [], {}, '/project')],
  ['room_import', b => b.roomImport('room', {}, '/project')],
  ['room_fork', b => b.roomFork('room', 'fork', 1)],
  ['session_save', b => b.sessionSave({ profiles: [{ access: 'full' }] })],
  ['settings_save', b => b.settingsSave({ access: 'full' })],
  ['room_delete', b => b.roomDelete('room')],
];

for (const [command, typed] of raising) {
  const routes = [['raw', b => b.call(command, { marker: command })], ['typed', typed]];
  for (const [route, invoke] of routes) {
    test(`${route} ${command} goes straight to the wire with no prompt`, async t => {
      const { backend, sent, native } = await connected(t);
      assert.equal(await invoke(backend), 'done');
      assert.deepEqual(native, [], 'nothing may ask the phone for authentication');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].cmd, command);
    });
  }
}

test('deleting a thread needs no prompt: the confirm the user sees is the confirmation', async t => {
  const { backend, sent, native } = await connected(t);
  assert.equal(await backend.call('room_delete', { id: 'room' }), 'done');
  assert.deepEqual(native, []);
  assert.equal(sent[0].cmd, 'room_delete');
  assert.deepEqual(sent[0].args, { id: 'room' });
});

test('the args a caller passed are the args on the wire, unchanged', async t => {
  const { backend, sent } = await connected(t);
  const args = { folder: '/project', nested: { access: 'full' }, list: [1, 2, 3] };
  await backend.call('folder_accept', args);
  assert.deepEqual(sent[0].args, { folder: '/project', nested: { access: 'full' }, list: [1, 2, 3] });
});

test('two commands in flight both reach the wire, in the order they were called', async t => {
  const { backend, sent, native } = await connected(t);
  await Promise.all([
    backend.call('folder_accept', { folder: '/first' }),
    backend.call('folder_accept', { folder: '/second' }),
  ]);
  assert.deepEqual(sent.map(frame => frame.args), [{ folder: '/first' }, { folder: '/second' }]);
  assert.deepEqual(native, []);
});

test('a command name that is not a string is refused before it reaches the wire', async t => {
  const { backend, sent, native } = await connected(t);
  for (const cmd of [new String('folder_accept'), { toJSON: () => 'settings_save' }, 42, null, undefined]) {
    await assert.rejects(backend.call(cmd, {}), /Invalid phone command/);
  }
  assert.deepEqual(sent, []);
  assert.deepEqual(native, []);
});

test('every daemon access_effect Raises arm reaches the real phone wire intact', async t => {
  // The cross-language drift check that outlived the local prompt: the phone must not rename, drop or
  // mangle a command the machine classifies as able to carry access. Whether it is allowed is the
  // machine's answer, so the command has to arrive for that answer to exist.
  const source = readFileSync(new URL('../crates/apex-daemon/src/authority.rs', import.meta.url), 'utf8');
  const body = source.split('pub fn access_effect(')[1].split('match command {')[1].split('\n}\n')[0]
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const arms = [...body.matchAll(/((?:\w+\s*\{[^}]*\}\s*\|?\s*)+)=>\s*Raises\b/g)];
  assert.equal(arms.length, [...body.matchAll(/=>\s*Raises\b/g)].length, 'every Raises arm must be understood by drift coverage');
  const commands = arms.flatMap(arm => [...arm[1].matchAll(/(\w+)\s*\{/g)])
    .map(match => match[1].replace(/[A-Z]/g, (letter, at) => (at ? '_' : '') + letter.toLowerCase()));
  assert.ok(commands.includes('folder_accept') && commands.includes('monitor_watch_save'), 'must discover daemon raising arms');
  const { backend, sent, native } = await connected(t);
  for (const command of commands) assert.equal(await backend.call(command, { marker: command }), 'done', `${command} must reach the machine`);
  assert.deepEqual(sent.map(frame => frame.cmd), commands);
  assert.deepEqual(native, [], 'no raise may stop at a local prompt');
});
