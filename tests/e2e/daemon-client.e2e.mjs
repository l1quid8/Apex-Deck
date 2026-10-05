// DaemonClient against the real apex-daemon: a chat, a dropped connection
// mid-turn that resumes with nothing missed or doubled, and a restarted
// daemon that asks for a resync.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonClient } from '../../src/daemon/client.ts';
import { socketLink } from './link.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = process.env.APEX_DAEMON_BIN ?? path.join(repo, 'target/debug/apex-daemon');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, test, ms = 20_000) {
  const start = Date.now();
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** `serve --exit-on-stdin-close` on `data`; ready once daemon.json exists. */
async function serve(data) {
  fs.rmSync(path.join(data, 'daemon.json'), { force: true });
  const child = spawn(BIN, ['serve', '--exit-on-stdin-close', '--data-dir', data], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  await until('daemon.json', () => {
    if (exited !== null) throw new Error(`the daemon exited (${exited}):\n${stderr}`);
    return fs.existsSync(path.join(data, 'daemon.json'));
  });
  return {
    child,
    stop: () => new Promise((resolve) => { child.once('exit', resolve); child.stdin.end(); }),
  };
}

const options = { policy: 'mention', max_bot_hops: 3 };
const shell = (id, script) => ({ id, display_name: id, backend: { kind: 'cli', program: 'sh', args: ['-c', script] } });
const added = (p) => p.event.type === 'message_added' ? p.event.message : null;

test('a client chats, resumes after a drop mid-turn, and is told to resync after a restart', { timeout: 60_000 }, async (t) => {
  const data = fs.mkdtempSync('/tmp/ade-');
  let daemon = await serve(data);
  let link = null;
  const client = new DaemonClient(async () => (link = await socketLink(path.join(data, 'daemon.sock'))), { delay: () => 100 });
  t.after(async () => { client.close(); await daemon.stop(); fs.rmSync(data, { recursive: true, force: true }); });
  const statuses = [];
  client.onStatus((s) => statuses.push(s.kind));
  const messages = [];
  client.on('room-event', (p) => { const m = added(p); if (m) messages.push(m.text); });
  const started = [];
  client.on('room-event', (p) => { if (p.event.type === 'turn_started') started.push(p.event.id); });

  const welcome = await client.start();
  assert.equal(welcome.protocol, 1);
  assert.equal(welcome.resumed, false);

  const room = await client.call('room_create', {
    id: 't1', options, cwd: null,
    participants: [shell('bot', 'echo hello from bot'), shell('slow', 'sleep 1; echo slow reply')],
  });
  assert.deepEqual(room.transcript, []);
  await client.call('room_post', { id: 't1', text: '@bot hi' });
  assert.deepEqual(messages, ['@bot hi', 'hello from bot']);

  // Drop the connection while slow works; its reply lands while we're away.
  const posted = client.call('room_post', { id: 't1', text: '@slow go' }).then(() => 'answered', (e) => e.message);
  await until('slow to start', () => started.includes('slow'));
  link.socket.destroy();
  assert.equal(await posted, 'The connection to the host was lost, so this may not have finished.');
  await until('the reconnect', () => statuses.at(-1) === 'connected' && statuses.includes('reconnecting'));
  await until('the reply', () => messages.includes('slow reply'));
  await sleep(1500);
  assert.deepEqual(messages, ['@bot hi', 'hello from bot', '@slow go', 'slow reply']);
  assert.ok(!statuses.includes('resync'));

  // A new boot can't resume: the window has to reload.
  await daemon.stop();
  daemon = await serve(data);
  await until('the resync', () => statuses.at(-1) === 'resync');
});
