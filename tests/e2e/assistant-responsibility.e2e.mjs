import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PROTOCOL } from '../../src/generated/protocol.ts';
import { configure, eventually, readAssistant, workspaceFixture } from './workspace-fixture.mjs';

const runFile = promisify(execFile);

// This is the CLI transport used for SSH. --attach prevents the client from
// becoming the Host itself. Each invocation exits before its result is returned.
async function callFromProcess(host, binary, command, args) {
  const request = runFile(binary, ['--stdio', '--attach', '--data-dir', host.data], { encoding: 'utf8', timeout: 15_000 });
  const hello = { id: 1, cmd: 'hello', args: { protocol: PROTOCOL } };
  request.child.stdin.end([hello, { id: 2, cmd: command, args }].map(frame => JSON.stringify(frame)).join('\n') + '\n');
  const { stdout } = await request;
  const frames = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(frames.find(frame => frame.id === 1)?.ok?.host_id, host.hostId);
  const reply = frames.find(frame => frame.id === 2);
  assert.ok(reply && Object.hasOwn(reply, 'ok'), JSON.stringify(reply));
  return reply.ok;
}

// Script the model responses. The daemon owns the rooms, follow-up, decision and recovery.
async function releaseWorkers(t) {
  const calls = { sam: 0, maya: 0 };
  const reports = { sam: 'Windows passed.', maya: 'Mac signing is blocked. The signing receipt is missing.' };
  const gates = { sam: Promise.withResolvers(), maya: Promise.withResolvers() };
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.end(JSON.stringify({ data: Object.keys(calls).map(id => ({ id, object: 'model' })) }));
      return;
    }
    const parts = [];
    for await (const data of request) parts.push(data);
    const { model } = JSON.parse(Buffer.concat(parts));
    if (!Object.hasOwn(calls, model)) { response.writeHead(400).end(); return; }
    const first = ++calls[model] === 1;
    if (first) await gates[model].promise;
    const reply = first ? reports[model] : 'I requested the signing receipt.';
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\ndata: [DONE]\n\n');
  });
  t.after(async () => {
    for (const gate of Object.values(gates)) gate.resolve();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const participants = Object.keys(calls).map(id => ({
    id, display_name: id === 'maya' ? 'Maya' : 'Sam', access: 'read',
    backend: { kind: 'open_ai_compatible', model: id, base_url: 'http://127.0.0.1:' + server.address().port + '/v1' },
  }));
  return { calls, gates, participants, reports };
}

test('one home follows a release with every client disconnected and answers Maya once across restart', { timeout: 90_000 }, async t => {
  const f = await workspaceFixture(t, 'adw-watch');
  const h = await f.host('home');
  const cwd = f.project('apex-deck');
  const project = { hostId: h.hostId, workspaceId: 'apex-deck', cwd };
  const workers = await releaseWorkers(t);
  const id = 'installer-qa';
  await h.client.call('session_save', { session: {
    version: 1, profiles: [f.profile, ...workers.participants],
    workspaces: [{ id: project.workspaceId, path: cwd, hostId: h.hostId }],
  } });
  const alfred = await h.client.call('personal_create', { name: 'Alfred', folder: f.root, profile: f.profile, workspaceVersion: 4 });
  await configure(h, alfred.id, { projects: [{ project, tools: 'full' }] });
  await h.client.call('room_create', { id, cwd, participants: workers.participants, options: { policy: 'mention', max_bot_hops: 0 } });
  await h.client.call('chat_update_meta', { id, title: 'Installer QA' });
  h.client.close();
  const fixture = process.env.APEX_DAEMON_BIN ?? path.resolve('target/debug/apex-daemon-fixture');
  const production = path.join(path.dirname(fixture), process.platform === 'win32' ? 'apex-daemon.exe' : 'apex-daemon');
  const cli = fs.existsSync(production) ? production : fixture;
  const watch = await callFromProcess(h, cli, 'personal_send', {
    assistantId: alfred.id, requestId: 'watch-this-installer',
    text: 'Keep an eye on the installer release through Friday. Let me know if anything puts it at risk.',
    viewContext: { hostId: h.hostId, focusedThreadId: id, openThreadIds: [id] },
  });

  const ledger = path.join(h.data, 'saved-chats-v1', 'personal-assistants.json.protected-fixture');
  const readSaved = () => JSON.parse(fs.readFileSync(ledger, 'utf8')).assistants.find(a => a.id === alfred.id);
  await eventually('watch acknowledged in the original chat', () => {
    const a = readSaved();
    return a.responsibilities?.length === 1 && a.messages.some(m => m.role === 'assistant' && m.eventId === watch.eventId);
  });
  await callFromProcess(h, cli, 'room_post_to', {
    id, targets: ['sam', 'maya'], text: 'Please report the Windows installer and Mac signing checks.',
  });
  await eventually('real worker call waiting for evidence', () => workers.calls.sam + workers.calls.maya > 0);
  assert.equal(readSaved().responsibilities[0].decision ?? null, null);
  // The last client process has exited. Release both worker reports and
  // inspect the protected fixture ledger without reconnecting to the daemon.
  const quietChat = readSaved().messages.map(m => m.id);
  workers.gates.sam.resolve();
  await eventually('Sam’s passing check was consumed without interrupting the user', () =>
    readSaved().responsibilities[0].workers.sam.report?.kind === 'clear');
  assert.deepEqual(readSaved().messages.map(m => m.id), quietChat);
  workers.gates.maya.resolve();
  const questioned = await eventually('Alfred saved a decision while disconnected', () => {
    const a = readSaved();
    return a.responsibilities[0].decision?.status === 'pending' && a;
  });
  const decision = questioned.responsibilities[0].decision;
  const message = questioned.messages.find(m => m.id === decision.messageId);
  assert.ok(message);
  assert.equal(decision.workerId, 'maya');
  assert.match(message.text, /signing receipt/i);
  assert.match(message.text, /windows passed/i);
  assert.match(message.text, /Maya/i);
  assert.deepEqual(workers.calls, { sam: 1, maya: 1 });
  t.diagnostic('With all clients closed, the home saved ' + message.id + ': ' + message.text);

  const reopened = await callFromProcess(h, cli, 'personal_get', { assistantId: alfred.id });
  assert.equal(reopened.responsibilities[0].decision.messageId, message.id);
  assert.equal(reopened.messages.filter(m => m.text === message.text).length, 1);
  t.diagnostic('A new ' + path.basename(cli) + ' --stdio --attach process reopened the pending decision.');

  await h.stop();
  await h.start();
  const afterBoot = await readAssistant(h, alfred.id);
  assert.equal(afterBoot.messages.filter(m => m.text === message.text).length, 1);
  const room = await h.client.call('room_state', { id });
  for (const report of Object.values(workers.reports)) assert.ok(room.snapshot.transcript.some(m => m.text === report));
  const answer = { assistantId: alfred.id, requestId: 'only-ask-maya', text: 'Yes. Only ask Maya.' };
  await h.client.call('personal_send', answer);
  await eventually('Maya alone received Alfred’s follow-up', () => workers.calls.maya === 2);
  const replay = await h.client.call('personal_send', answer);
  assert.equal(replay.duplicate, true);
  await eventually('targeted worker reply is durable', async () => {
    const thread = await h.client.call('room_state', { id });
    return thread.snapshot.transcript.some(m => m.text === 'I requested the signing receipt.');
  });
  await h.stop();
  await h.start();
  const restored = await readAssistant(h, alfred.id);
  assert.equal(restored.messages.filter(m => m.text === message.text).length, 1);
  // A stale answer from a second device can have its own client request ID.
  const repeated = await h.client.call('personal_send', { ...answer, requestId: 'repeat-from-phone' });
  await eventually('second device learns the decision was already answered', async () => {
    const a = await readAssistant(h, alfred.id);
    return a.messages.some(m => m.eventId === repeated.eventId && m.role === 'assistant' && /already been answered/i.test(m.text));
  });
  assert.deepEqual(workers.calls, { sam: 1, maya: 2 });
});
