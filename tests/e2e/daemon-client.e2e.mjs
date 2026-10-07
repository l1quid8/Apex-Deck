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

test('decision settings round-trip through the daemon, remain off by default, and reject an empty secret', { timeout: 30_000 }, async (t) => {
  const data = fs.mkdtempSync('/tmp/ade-dec-');
  const daemon = await serve(data);
  const client = new DaemonClient(() => socketLink(path.join(data, 'daemon.sock')));
  t.after(async () => { client.close(); await daemon.stop(); fs.rmSync(data, { recursive: true, force: true }); });
  await client.start();
  const settings = { version: 1, confirmSteer: true, decision: { enabled: false, provider: 'jev', accountId: '' } };
  await client.call('settings_save', { settings });
  assert.deepEqual(await client.call('settings_load'), settings);
  await assert.rejects(client.call('decision_key_save', { provider: 'jev', key: '' }), /API key must not be empty/);
  assert.deepEqual(await client.call('settings_load'), settings);
  assert.ok(!fs.readFileSync(path.join(data, 'saved-chats-v1', 'settings.json'), 'utf8').includes('decisionApiKey'));
  await client.call('room_create', { id: 'decision-off', options, cwd: null, participants: [shell('bot', 'echo observer does not route')] });
  await client.call('room_post', { id: 'decision-off', text: 'hello' });
  assert.equal(fs.existsSync(path.join(data, 'decisions.jsonl')), false);
});

test('manual steer and picture targets bypass observation even with a broken provider', { timeout: 30_000 }, async (t) => {
  const data = fs.mkdtempSync('/tmp/ade-dec-manual-');
  const daemon = await serve(data);
  const client = new DaemonClient(() => socketLink(path.join(data, 'daemon.sock')));
  t.after(async () => { client.close(); await daemon.stop(); fs.rmSync(data, { recursive: true, force: true }); });
  await client.start();
  await client.call('settings_save', { settings: { decision: { enabled: true, provider: 'cloudflare', accountId: '../invalid' } } });
  await client.call('room_create', { id: 'manual', options, cwd: null, participants: [shell('bot', 'echo reply')] });
  await client.call('room_post_to', { id: 'manual', text: 'steer without mention', targets: ['bot'] });
  await client.call('room_post_to', { id: 'manual', text: 'Picture from camera', targets: [] });
  assert.equal(fs.existsSync(path.join(data, 'decisions.jsonl')), false);
  await client.call('room_post', { id: 'manual', text: 'ordinary routed message' });
  await until('provider failure observation', () => fs.existsSync(path.join(data, 'decisions.jsonl')));
  const rows = fs.readFileSync(path.join(data, 'decisions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].error);
  assert.deepEqual(rows[0].deck_targets, ['bot']);
});

test('two devices receive model/reasoning edits without overwriting unrelated settings', { timeout: 30_000 }, async (t) => {
  const data = fs.mkdtempSync('/tmp/ade-settings-sync-');
  const daemon = await serve(data);
  const connect = () => new DaemonClient(() => socketLink(path.join(data, 'daemon.sock')));
  const phone = connect(); const desktop = connect();
  t.after(async () => { phone.close(); desktop.close(); await daemon.stop(); fs.rmSync(data, { recursive: true, force: true }); });
  await Promise.all([phone.start(), desktop.start()]);
  const events = [[], []];
  [phone, desktop].forEach((client, i) => client.on('room-event', p => { if (p.room === 'sync' && p.event.type === 'participant_changed') events[i].push(p.event.participant); }));
  const base = { id: 'null', display_name: 'Null', persona: '', access: 'ask', effort: 'high', backend: { kind: 'open_ai_compatible', base_url: 'http://127.0.0.1:1', model: 'old', api_key_env: null } };
  await phone.call('room_create', { id: 'sync', participants: [base], options, cwd: null });
  const first = await phone.call('room_update_participant', { id: 'sync', base, participant: { ...base, backend: { ...base.backend, model: 'new' } } });
  assert.equal(first.backend.model, 'new');
  // The desktop still has the opening config. Its reasoning edit must not undo the phone's model.
  const second = await desktop.call('room_update_participant', { id: 'sync', base, participant: { ...base, effort: 'low' } });
  assert.equal(second.backend.model, 'new');
  assert.equal(second.effort, 'low');
  await until('both clients to see both settings changes', () => events.every(list => list.length === 2));
  assert.deepEqual(events[0], events[1]);
  assert.deepEqual(events[0].at(-1), second);
  // Explicit Default remains a real edit; an untouched model remains intact.
  const third = await phone.call('room_update_participant', { id: 'sync', base: second, participant: { ...second, effort: null } });
  assert.equal(third.effort, null);
  assert.equal(third.backend.model, 'new');
  const state = await desktop.call('room_state', { id: 'sync' });
  assert.deepEqual(state.snapshot.participants[0], third);
});
