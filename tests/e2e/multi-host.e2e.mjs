import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DaemonClient } from '../../src/daemon/client.ts';
import { daemonTransport } from '../../src/electronShell.ts';
import { commandBackend } from '../../src/commandBackend.ts';
import { createHostBackends } from '../../src/hostBackends.ts';
import { createEventHub } from '../../src/eventHub.ts';
import { socketLink } from './link.mjs';
import { FolderMoveUnsupported, placeThread } from '../../src/threadMove.ts';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await pause(20); }
  throw new Error('timed out');
}
async function daemon(t) {
  const data = fs.mkdtempSync('/tmp/adm-');
  const binary = path.resolve('target/debug/apex-daemon');
  const child = spawn(binary, ['serve', '--exit-on-stdin-close', '--data-dir', data],
    { stdio: ['pipe', 'ignore', 'pipe'] });
  let exit = null; let error = ''; let spawnError = ''; let link; let client;
  child.once('error', e => { spawnError = e.message; });
  child.once('exit', code => { exit = code; });
  child.stderr.on('data', bytes => { error += bytes; });
  t.after(async () => {
    client?.close();
    if (exit === null && !spawnError) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end();
      const finished = await Promise.race([stopped.then(() => true), pause(5000).then(() => false)]);
      if (!finished) { child.kill('SIGKILL'); await Promise.race([stopped, pause(1000)]); }
    }
    // Checkpoint git runs started by the daemon can still be finishing in its data folder.
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await until(() => {
    if (spawnError || exit !== null) throw new Error(spawnError || error || 'daemon exited');
    return fs.existsSync(path.join(data, 'daemon.json'));
  });
  let status = { kind: 'connecting' };
  const listeners = new Set();
  client = new DaemonClient(async () =>
    (link = await socketLink(path.join(data, 'daemon.sock'))), { delay: () => 60000 });
  client.onStatus(next => { status = next; listeners.forEach(cb => cb()); });
  const connection = {
    get: () => ({ status }),
    subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb); },
    retryNow: () => client.retryNow(),
  };
  const welcome = await client.start();
  const backend = commandBackend(daemonTransport(client), { quitStopsWork: false });
  return { data, welcome, client, backend, connection, breakLink: () => link.socket.destroy() };
}
const options = { policy: 'mention', max_bot_hops: 0 };
const bot = label => ({
  id: 'bot', display_name: label,
  backend: { kind: 'cli', program: 'sh', args: ['-c', 'echo ' + label] },
});
test('real host backends isolate a drop and do not replay rejected text', { timeout: 30000 }, async t => {
  const mac = await daemon(t); const server = await daemon(t);
  assert.notEqual(mac.welcome.host_id, server.welcome.host_id);
  const registry = createHostBackends({
    local: mac.backend,
    hosts: [{ id: 'h-at', name: 'Apex-Terminal', remote: true }],
    make: () => ({
      backend: server.backend, connection: server.connection,
      start: () => server.client.start(), close: () => server.client.close(),
    }),
  });
  const remote = registry.get('h-at');
  const heard = [];
  const hub = createEventHub({});
  t.after(() => registry.dispose('h-at'));
  const offMac = await hub.start(mac.backend, 'local');
  const offServer = await hub.start(remote, 'h-at');
  t.after(() => { offMac(); offServer(); });
  hub.registerRoom('same-id', e => heard.push(['local', e]), 'local');
  hub.registerRoom('same-id', e => heard.push(['h-at', e]), 'h-at');
  await mac.backend.roomCreate('same-id', [bot('mac-reply')], options, '');
  await remote.roomCreate('same-id', [bot('server-reply')], options, '');
  await Promise.all([
    mac.backend.roomPost('same-id', '@bot first'),
    remote.roomPost('same-id', '@bot first'),
  ]);
  await until(() => heard.some(([host, e]) => host === 'local' && e.type === 'message_added' && e.message.text === 'mac-reply'));
  await until(() => heard.some(([host, e]) => host === 'h-at' && e.type === 'message_added' && e.message.text === 'server-reply'));
  server.breakLink();
  await until(() => server.connection.get().status.kind === 'reconnecting');
  await assert.rejects(remote.roomPost('same-id', '@bot offline-draft'));
  await mac.backend.roomPost('same-id', '@bot second');
  assert.equal(mac.connection.get().status.kind, 'connected');
  server.connection.retryNow();
  await until(() => server.connection.get().status.kind === 'connected');
  const state = await remote.roomState('same-id');
  assert.equal(state.snapshot.transcript.some(m => m.text.includes('offline-draft')), false);
  assert.equal(heard.some(([host, e]) => host === 'local' &&
    e.type === 'message_added' && e.message.text === 'server-reply'), false);
  assert.equal(heard.some(([host, e]) => host === 'h-at' &&
    e.type === 'message_added' && e.message.text === 'mac-reply'), false);
});

// Moving a thread that hasn't started: what it had must still be somewhere whole.
const page = { version: 1, artifacts: [{ id: 'a1', title: 'Page', kind: 'html', versions: [{ n: 1, source: '<p>hi</p>', by: 'bot', seq: 2, at: 1 }] }] };
const savedRoom = (data, id) => path.join(data, 'saved-chats-v1', 'rooms', `${Buffer.from(id).toString('hex')}.json`);
function folders(t) {
  const root = fs.mkdtempSync('/tmp/adf-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return ['a', 'b'].map(name => { const dir = path.join(root, name); fs.mkdirSync(dir); return dir; });
}
/** A cleared thread: no messages, but its bot, a pin and an artifact. */
async function cleared(backend, folder) {
  await backend.roomCreate('t', [bot('kept')], options, folder);
  await backend.roomPin('t', 'use pnpm');
  await backend.artifactsSave('t', page);
  return (await backend.roomState('t')).snapshot;
}
test('an older helper keeps a thread whole when it cannot move it to another folder', { timeout: 30000 }, async t => {
  const server = await daemon(t); const [a, b] = folders(t);
  // An apex-daemon from before room_import: the same daemon without that command.
  const older = { ...server.backend, roomImport: async () => { throw new Error('unknown variant `room_import`, expected one of `session_load`'); } };
  const snapshot = await cleared(server.backend, a);
  await assert.rejects(placeThread({ from: older, to: older, id: 't', snapshot, cwd: b, sameHost: true, hostName: 'AT' }), FolderMoveUnsupported);
  const after = (await server.backend.roomState('t')).snapshot;
  assert.deepEqual(after.participants.map(p => p.display_name), ['kept']);
  assert.deepEqual(after.pins, ['use pnpm']);
  assert.deepEqual(await server.backend.artifactsLoad('t'), page);
  assert.equal(JSON.parse(fs.readFileSync(savedRoom(server.data, 't'), 'utf8')).cwd, a);
});
test('a thread moved to another machine takes its bot, pins and artifacts, and the old copy goes', { timeout: 30000 }, async t => {
  const mac = await daemon(t); const server = await daemon(t); const [a, b] = folders(t);
  const snapshot = await cleared(mac.backend, a);
  assert.equal(await placeThread({ from: mac.backend, to: server.backend, id: 't', snapshot, cwd: b, sameHost: false, hostName: 'AT' }), 'imported');
  const there = await server.backend.roomCreate('t', [], options, b);
  assert.deepEqual(there.participants.map(p => p.display_name), ['kept']);
  assert.deepEqual(there.pins, ['use pnpm']);
  assert.deepEqual(await server.backend.artifactsLoad('t'), page);
  assert.equal(fs.existsSync(savedRoom(mac.data, 't')), false);
  assert.equal(await mac.backend.artifactsLoad('t'), null);
});
test('a move whose artifacts cannot be saved there leaves the thread whole where it was', { timeout: 30000 }, async t => {
  const mac = await daemon(t); const server = await daemon(t); const [a, b] = folders(t);
  const full = { ...server.backend, artifactsSave: async () => { throw new Error('No space left on device'); } };
  const snapshot = await cleared(mac.backend, a);
  await assert.rejects(placeThread({ from: mac.backend, to: full, id: 't', snapshot, cwd: b, sameHost: false, hostName: 'AT' }), /No space left/);
  assert.equal(fs.existsSync(savedRoom(server.data, 't')), false);
  assert.deepEqual((await mac.backend.roomState('t')).snapshot.pins, ['use pnpm']);
  assert.deepEqual(await mac.backend.artifactsLoad('t'), page);
});
