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
    fs.rmSync(data, { recursive: true, force: true });
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
