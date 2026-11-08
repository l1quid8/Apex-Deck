import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Capacitor } from '@capacitor/core';
import { phoneShell } from '../src/phoneShell.ts';

// Keep the real Capacitor proxy, phone backend, command backend, daemon
// transport, client and connection store. Only native auth and the wire are fake.
Capacitor.PluginHeaders = [{ name: 'ApexSsh', methods: [{ name: 'authenticateBiometric', rtype: 'promise' }] }];
const { openPhoneHost } = await import('../src/phoneBackend.ts');
const { requireFaceId } = await import('../src/phone/biometric.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
const machine = { id: 'bio-host', name: 'Test machine', kind: 'server', url: 'wss://example.test', token: 'token' };

async function connected(t, authenticate) {
  const native = [];
  Capacitor.nativePromise = (plugin, method, options) => {
    native.push({ plugin, method, options });
    assert.equal(plugin, 'ApexSsh');
    assert.equal(method, 'authenticateBiometric', 'must not retrieve an SSH secret');
    return authenticate(options);
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

// These commands and typed routes are derived from the daemon's Raises arms.
const raising = [
  ['room_add_participant', b => b.roomAddParticipant('room', { id: 'bot', access: 'full' })],
  ['room_update_participant', b => b.roomUpdateParticipant('room', { id: 'bot', access: 'full' })],
  ['room_create', b => b.roomCreate('room', [], {}, '/project')],
  ['room_import', b => b.roomImport('room', {}, '/project')],
  ['room_fork', b => b.roomFork('room', 'fork', 1)],
  ['chat_promote', null],
  ['room_mount', null],
  ['folder_accept', null],
  ['session_save', b => b.sessionSave({ profiles: [{ access: 'full' }] })],
  ['settings_save', b => b.settingsSave({ access: 'full' })],
  ['monitor_watch_save', null],
];

for (const [command, typed] of raising) {
  const routes = [['raw', b => b.call(command, { marker: command })]];
  if (typed) routes.unshift(['typed', typed]);
  for (const [route, invoke] of routes) {
    test(`${route} ${command} sends only after its native biometric success`, async t => {
      let finish;
      const { backend, sent, native } = await connected(t, () => new Promise(resolve => { finish = resolve; }));
      const pending = invoke(backend);
      await tick();
      assert.deepEqual(sent, [], 'raising command must wait behind authentication');
      assert.equal(native.length, 1);
      assert.match(native[0].options.reason, /Test machine/);
      finish({ authenticated: true });
      assert.equal(await pending, 'done');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].cmd, command);
    });
  }
}

for (const [failure, authenticate] of [
  ['cancel', () => Promise.reject(new Error('user cancelled'))],
  ['failure', () => Promise.reject(new Error('authentication failed'))],
  ['unavailable', () => Promise.reject(new Error('biometry unavailable'))],
  ['negative native result', () => Promise.resolve({ authenticated: false })],
  ['malformed native result', () => Promise.resolve({})],
]) {
  for (const [route, invoke] of [['typed', raising[1][1]], ['raw', b => b.call('folder_accept', { folder: '/project' })]]) {
    test(`${route} ${failure} transmits no raising command and cannot fall back to confirmation`, async t => {
      const oldWindow = globalThis.window;
      globalThis.window = { confirm: () => { throw new Error('confirmation must never be used'); } };
      t.after(() => { globalThis.window = oldWindow; });
      const { backend, sent } = await connected(t, authenticate);
      await assert.rejects(invoke(backend), /biometric/i);
      assert.deepEqual(sent, []);
    });
  }
}

test('a missing native plugin fails closed even with an approving confirmation dialog', async t => {
  const headers = Capacitor.PluginHeaders;
  const available = Capacitor.isPluginAvailable;
  const oldWindow = globalThis.window;
  Capacitor.PluginHeaders = [];
  Capacitor.isPluginAvailable = () => false;
  globalThis.window = { confirm: () => true };
  t.after(() => { Capacitor.PluginHeaders = headers; Capacitor.isPluginAvailable = available; globalThis.window = oldWindow; });
  const { backend, sent, native } = await connected(t, () => { throw new Error('no native plugin'); });
  assert.equal(await requireFaceId('test'), false);
  await assert.rejects(backend.call('settings_save', { settings: {} }), /biometric/i);
  assert.deepEqual(sent, []);
  assert.deepEqual(native, []);
});

test('an older SSH plugin without the dedicated biometric operation fails closed', async t => {
  const header = Capacitor.PluginHeaders[0];
  const methods = header.methods;
  header.methods = [];
  t.after(() => { header.methods = methods; });
  const { backend, sent, native } = await connected(t, () => Promise.resolve({ authenticated: true }));
  await assert.rejects(backend.call('folder_accept', { folder: '/project' }), /biometric/i);
  assert.deepEqual(sent, []);
  assert.deepEqual(native, []);
});

test('raw command objects cannot serialize into a raising route after bypassing classification', async t => {
  const { backend, sent } = await connected(t, () => Promise.reject(new Error('cancelled')));
  for (const cmd of [new String('folder_accept'), { toJSON: () => 'settings_save' }]) {
    await assert.rejects(backend.call(cmd, {}), /command|biometric/i);
  }
  assert.deepEqual(sent, []);
});

test('simultaneous intents cannot share authentication or reuse a previous success', async t => {
  const attempts = [];
  const { backend, sent } = await connected(t, () => new Promise((resolve, reject) => attempts.push({ resolve, reject })));
  const first = backend.call('folder_accept', { folder: '/first' });
  const second = backend.call('folder_accept', { folder: '/second' });
  const secondRejected = assert.rejects(second, /biometric/i);
  await tick();
  assert.equal(attempts.length, 2);
  attempts[0].resolve({ authenticated: true });
  await first;
  assert.deepEqual(sent.map(frame => frame.args), [{ folder: '/first' }]);
  attempts[1].reject(new Error('cancelled'));
  await secondRejected;
  const third = backend.call('folder_accept', { folder: '/third' });
  await tick();
  assert.equal(attempts.length, 3);
  assert.equal(sent.length, 1, 'previous success grants no reuse window');
  attempts[2].resolve({ authenticated: true });
  await third;
  assert.deepEqual(sent.map(frame => frame.args), [{ folder: '/first' }, { folder: '/third' }]);
});

test('the command payload is fixed before authentication and cannot change to a different intent', async t => {
  let finish;
  const { backend, sent } = await connected(t, () => new Promise(resolve => { finish = resolve; }));
  const args = { folder: '/approved', nested: { access: 'read' } };
  const pending = backend.call('folder_accept', args);
  await tick();
  args.folder = '/different';
  args.nested.access = 'full';
  assert.equal(typeof finish, 'function', 'must invoke native authentication');
  finish({ authenticated: true });
  await pending;
  assert.deepEqual(sent[0].args, { folder: '/approved', nested: { access: 'read' } });
});

test('ordinary reads and proven non-raising commands do not require biometrics', async t => {
  const { backend, sent, native } = await connected(t, () => { throw new Error('must not authenticate'); });
  for (const cmd of ['room_state', 'chat_create', 'room_rewind', 'room_decide', 'room_runner_start']) {
    assert.equal(await backend.call(cmd, { id: 'room' }), 'done');
  }
  assert.equal(sent.length, 5);
  assert.deepEqual(native, []);
});

test('every daemon access_effect Raises arm is guarded at the real phone wire boundary', async t => {
  // This cross-language drift check intentionally reads Rust classification,
  // then tests transmission behavior rather than matching TypeScript source.
  const source = readFileSync(new URL('../crates/apex-daemon/src/authority.rs', import.meta.url), 'utf8');
  const body = source.split('pub fn access_effect(')[1].split('match command {')[1].split('\n}\n')[0]
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const arms = [...body.matchAll(/((?:\w+\s*\{[^}]*\}\s*\|?\s*)+)=>\s*Raises\b/g)];
  assert.equal(arms.length, [...body.matchAll(/=>\s*Raises\b/g)].length, 'every Raises arm must be understood by drift coverage');
  const commands = arms.flatMap(arm => [...arm[1].matchAll(/(\w+)\s*\{/g)])
    .map(match => match[1].replace(/[A-Z]/g, (letter, at) => (at ? '_' : '') + letter.toLowerCase()));
  assert.ok(commands.includes('folder_accept') && commands.includes('monitor_watch_save'), 'must discover daemon raising arms');
  const { backend, sent } = await connected(t, () => Promise.reject(new Error('cancelled')));
  for (const command of commands) {
    await assert.rejects(backend.call(command, {}), /biometric/i, `${command} needs authentication`);
  }
  assert.deepEqual(sent, []);
});
