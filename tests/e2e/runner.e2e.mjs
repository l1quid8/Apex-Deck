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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function until(what, testFn, ms = 20000) {
  const start = Date.now();
  for (;;) {
    const v = await testFn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

async function serve(data) {
  fs.rmSync(path.join(data, 'daemon.json'), { force: true });
  const child = spawn(BIN, ['serve', '--exit-on-stdin-close', '--data-dir', data], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; console.error('[daemon]', d.toString()); });
  let exited = null;
  child.on('exit', c => { exited = c; });
  await until('daemon.json', () => {
    if (exited !== null) throw new Error(`daemon exited (${exited}):\n${stderr}`);
    return fs.existsSync(path.join(data, 'daemon.json'));
  });
  return { child, getStderr: () => stderr, stop: () => new Promise(res => { child.once('exit', res); child.stdin.end(); }) };
}

const options = { policy: 'mention', max_bot_hops: 0 };

test('runner lifecycle via daemon: start, pause, resume, end, new start after finished', { timeout: 60000 }, async (t) => {
  const data = fs.mkdtempSync('/tmp/runner-e2e-');
  const daemon = await serve(data);
  const client = new DaemonClient(() => socketLink(path.join(data, 'daemon.sock')));
  t.after(async () => { client.close(); await daemon.stop(); fs.rmSync(data, { recursive: true, force: true }); });
  await client.start();

  const roomId = 'room-runner-test';
  try {
    await client.call('room_create', { id: roomId, options, cwd: null, participants: [] });
  } catch (e) {
    console.error('room_create failed', e);
    throw e;
  }

  // Initially no runner
  let state;
  try {
    state = await client.call('room_runner_state', { id: roomId });
  } catch (e) {
    console.error('room_runner_state failed', e);
    throw e;
  }
  assert.equal(state, null);

  const limits = { schemaVersion: 1, maxTurns: 30, maxInvocations: 120, lifetimeMs: 7200000, maxCostMicros: 5000000 };

  // Start goal
  let startRes;
  try {
    startRes = await client.call('room_runner_start', { id: roomId, requestId: 'req1', runner: { schemaVersion: 1, kind: 'goal', objective: 'fix login', workers: ['w1'], limits } });
  } catch (e) {
    console.error('room_runner_start failed', e);
    throw e;
  }
  assert.ok(startRes.applied);
  assert.equal(startRes.applied.phase, 'running');
  const runnerId = startRes.applied.id;
  const rev1 = startRes.applied.revision;

  // Duplicate request idempotent
  const dup = await client.call('room_runner_start', { id: roomId, requestId: 'req1', runner: { schemaVersion: 1, kind: 'goal', objective: 'fix login', workers: ['w1'], limits } });
  assert.deepEqual(dup, startRes);

  // Pause
  const paused = await client.call('room_runner_action', { id: roomId, runnerId, expectedRevision: rev1, requestId: 'req-pause', action: { action: 'pause' } });
  assert.equal(paused.applied.phase, 'paused');
  const rev2 = paused.applied.revision;

  // Resume
  const resumed = await client.call('room_runner_action', { id: roomId, runnerId, expectedRevision: rev2, requestId: 'req-resume', action: { action: 'resume' } });
  assert.equal(resumed.applied.phase, 'running');
  const rev3 = resumed.applied.revision;

  // End
  const ended = await client.call('room_runner_action', { id: roomId, runnerId, expectedRevision: rev3, requestId: 'req-end', action: { action: 'end' } });
  assert.equal(ended.applied.phase, 'ended');

  // New start after finished should be allowed
  const start2 = await client.call('room_runner_start', { id: roomId, requestId: 'req2', runner: { schemaVersion: 1, kind: 'goal', objective: 'new objective', workers: ['w1'], limits } });
  assert.ok(start2.applied);
  assert.notEqual(start2.applied.id, runnerId);

  // Loop with interval
  await client.call('room_runner_action', { id: roomId, runnerId: start2.applied.id, expectedRevision: start2.applied.revision, requestId: 'req-end2', action: { action: 'end' } });

  const loopLimits = { schemaVersion: 1, maxTurns: 10, maxInvocations: 20, lifetimeMs: 7200000, maxCostMicros: 5000000 };
  const loopStart = await client.call('room_runner_start', { id: roomId, requestId: 'req-loop', runner: { schemaVersion: 1, kind: 'loop', prompt: 'check build', intervalSeconds: 600, workers: ['w1'], limits: loopLimits } });
  assert.ok(loopStart.applied);
  assert.equal(loopStart.applied.kind, 'loop');
  assert.equal(loopStart.applied.intervalSeconds, 600);
  assert.ok(loopStart.applied.nextRunAt);
});

test('runner stale revision conflicts and human message pauses', { timeout: 30000 }, async (t) => {
  const data = fs.mkdtempSync('/tmp/runner-stale-');
  const daemon = await serve(data);
  const client = new DaemonClient(() => socketLink(path.join(data, 'daemon.sock')));
  t.after(async () => { client.close(); await daemon.stop(); fs.rmSync(data, { recursive: true, force: true }); });
  await client.start();

  const roomId = 'room-stale';
  await client.call('room_create', { id: roomId, options, cwd: null, participants: [] });
  const limits = { schemaVersion: 1, maxTurns: 30, maxInvocations: 120, lifetimeMs: 7200000, maxCostMicros: 5000000 };
  const started = await client.call('room_runner_start', { id: roomId, requestId: 'r1', runner: { schemaVersion: 1, kind: 'goal', objective: 'obj', workers: ['w1'], limits } });
  const runnerId = started.applied.id;

  // Stale revision
  const stale = await client.call('room_runner_action', { id: roomId, runnerId, expectedRevision: 999, requestId: 'bad', action: { action: 'pause' } });
  assert.ok(stale.conflict);

  // Human message pauses (simulate via room_post, which triggers human precedence hook)
  await client.call('room_post', { id: roomId, text: 'hello human' });
  // Give time for host to process human message pause
  await sleep(200);
  const afterHuman = await client.call('room_runner_state', { id: roomId });
  // Should be paused with human reason (or at least paused)
  assert.equal(afterHuman.phase, 'paused');
});
