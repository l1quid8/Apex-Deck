import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { DaemonClient } from '../../src/daemon/client.ts';
import { socketLink } from './link.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bin = process.env.APEX_DAEMON_BIN ?? path.join(repo, 'target/debug/apex-daemon');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(label, read, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  do { const value = await read(); if (value) return value; await sleep(25); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
async function serve(data, env = {}) {
  fs.rmSync(path.join(data, 'daemon.json'), { force: true });
  const child = spawn(bin, ['serve', '--exit-on-stdin-close', '--data-dir', data], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, ...env } });
  let error = ''; child.stderr.on('data', chunk => { error += chunk; });
  await until('daemon startup', () => {
    if (child.exitCode !== null) throw new Error(error);
    return fs.existsSync(path.join(data, 'daemon.json'));
  });
  return { stop: async () => {
    if (child.exitCode !== null) return;
    const finished = new Promise(resolve => child.once('exit', resolve));
    child.stdin.end(); await finished;
  } };
}
const options = { policy: 'mention', max_bot_hops: 0 };
const worker = (id, script) => ({ id, display_name: id, access: 'edits', backend: { kind: 'cli', program: 'sh', args: ['-c', script] } });

test('natural named-worker read-only tasks keep questions human-owned and persist spend pauses across restart', { timeout: 60_000 }, async t => {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/ade-v3-budget-'));
  const cwd = path.join(base, 'project'), data = path.join(base, 'data'), tools = path.join(base, 'tools');
  for (const directory of [cwd, data, tools]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(cwd, 'README.md'), 'Human project without Git.\n');
  fs.writeFileSync(path.join(tools, 'claude'), `#!/bin/sh
case "$*" in *'--disallowedTools Edit,Write,NotebookEdit,Bash'*) ;; *) echo 'missing enforced read-only flags' >&2; exit 9;; esac
IFS= read -r prompt
echo '{"type":"system","subtype":"init"}'
case "$prompt" in *'Resume the original task'*) ;; *)
echo '{"type":"control_request","request_id":"scope-question","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"header":"Scope","question":"Which chats should I review?","options":[{"label":"Open only","description":"Leave archived chats alone"},{"label":"All chats"}],"multiSelect":false},{"header":"Location","question":"Which project?","options":[{"label":"This project"},{"label":"All projects"}],"multiSelect":false}]}}}'
IFS= read -r answer
case "$answer" in *'Open only'*'This project'*) ;; *) echo 'missing complete human answers' >&2; exit 10;; esac
;; esac
echo '{"type":"result","subtype":"success","is_error":false,"result":"Reviewed the open chats. Two need follow-up; archived chats are unchanged.","total_cost_usd":0.12,"usage":{"input_tokens":10,"output_tokens":5}}'
cat >/dev/null
`, { mode: 0o755 });
  const reasoner = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* bounded fixture request */ }
    if (request.method !== 'POST') { response.end('{"data":[]}'); return; }
    const intent = { kind: 'handoff', message: 'Handing your review to Luna.', brief: 'Review the open chats and return findings.', threadId: 'invented', workers: ['invented'], reviewCriteria: [] };
    response.setHeader('Content-Type', 'text/event-stream');
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(intent) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => reasoner.listen(0, '127.0.0.1', resolve));
  const env = { PATH: `${tools}:${process.env.PATH}`, SHELL: '/bin/false' };
  let daemon = await serve(data, env);
  const connect = () => new DaemonClient(() => socketLink(path.join(data, 'daemon.sock')));
  let desktop = connect(), phone = connect();
  t.after(async () => { desktop.close(); phone.close(); await daemon.stop(); await new Promise(resolve => reasoner.close(resolve)); fs.rmSync(base, { recursive: true, force: true }); });
  await Promise.all([desktop.start(), phone.start()]);
  const profile = { id: 'assistant', display_name: 'Assistant', access: 'read', backend: { kind: 'open_ai_compatible', base_url: `http://127.0.0.1:${reasoner.address().port}/v1`, model: 'fixture', api_key_env: null } };
  const monitor = await desktop.call('monitor_assign', { workspaceId: 'project', cwd, hostId: 'local', text: 'Help with my requested project work', files: [], threads: [], profile });
  const owner = { workspaceId: 'project', cwd, hostId: 'local', conversationId: monitor.conversationId };
  await desktop.call('monitor_pause', { ...owner, paused: true });
  const luna = { id: 'luna', display_name: 'Luna', access: 'full', backend: { kind: 'agent', tool: 'claude_code', model: null } };
  const input = { ...owner, requestId: 'v3-read-only', text: 'Ask Luna to review my unfinished chats', destination: null, newWorkerProfiles: [], workerProfiles: [luna], threadLabels: [], mode: 'read_only', checks: [], spendLimitMicros: 100_000 };
  const response = await desktop.call('assistant_message', input);
  const taskId = response.task.id;
  assert.deepEqual(response.task.workers, ['luna'], 'actual human name resolves the catalogue; model IDs do not');
  const list = async () => (await phone.call('assistant_tasks_list', { owner })).tasks.find(task => task.id === taskId);
  const question = await until('two human-owned worker questions', async () => { const task = await list(); return task.status === 'needs_you' && task.resultData.pendingQuestions?.[0]?.questions?.length === 2 ? task : null; });
  assert.equal(question.resultData.leaseHeld, false);
  const wait = question.resultData.pendingQuestions[0];
  await phone.call('room_answer', { id: question.executionThreadId, request: wait.request, answers: [['Open only'], ['This project']] });
  const paused = await until('settled spend pause', async () => { const task = await list(); return task.status === 'needs_you' && task.resultData.budgetPaused && task.attempts[0].finishedAtMs ? task : null; }).catch(async error => { error.message += `: ${JSON.stringify(await list())}`; throw error; });
  assert.equal(paused.usage.costMicros, 120_000);
  await assert.rejects(desktop.call('assistant_task_action', { taskId, owner, revision: paused.revision, action: 'resume_budget' }), /limit/i);
  const noted = await desktop.call('assistant_task_action', { taskId, owner, revision: paused.revision, action: 'note', text: 'Keep the archived chats untouched.' });
  assert.ok(noted.resultData.taskHistory.some(entry => entry.kind === 'note'));
  desktop.close(); phone.close(); await daemon.stop();
  daemon = await serve(data, env); desktop = connect(); phone = connect(); await Promise.all([desktop.start(), phone.start()]);
  const restored = await list();
  assert.equal(restored.status, 'needs_you'); assert.equal(restored.resultData.budgetPaused, true); assert.equal(restored.attempts.length, 1);
  const raised = await desktop.call('assistant_task_action', { taskId, owner, revision: restored.revision, action: 'set_budget', spendLimitMicros: 500_000 });
  await desktop.call('assistant_task_action', { taskId, owner, revision: raised.revision, action: 'resume_budget' });
  const ready = await until('resumed worker result', async () => { const task = await list(); return task.status === 'ready_for_review' ? task : null; });
  assert.equal(ready.attempts.length, 2); assert.equal(ready.usage.costMicros, 240_000);
  assert.match(ready.result, /Two need follow-up/); assert.equal(ready.originalRequest, input.text);
  const state = await desktop.call('room_state', { id: ready.executionThreadId });
  assert.equal(state.snapshot.participants[0].access, 'read');
  assert.ok(state.snapshot.transcript.some(message => message.text.includes('Additional human note') && message.text.includes('archived chats untouched')));
  await assert.rejects(desktop.call('room_update_participant', { id: ready.executionThreadId, participant: luna }), /read.only/i);
  const done = await desktop.call('assistant_task_action', { taskId, owner, revision: ready.revision, action: 'review' });
  assert.equal(done.status, 'done'); assert.equal(fs.readFileSync(path.join(cwd, 'README.md'), 'utf8'), 'Human project without Git.\n');
  assert.deepEqual(fs.readdirSync(cwd), ['README.md']);
});

test('assistant delegates once, survives pane detach, holds review for phone acceptance, and restores receipts', { timeout: 60_000 }, async t => {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/ade-assistant-'));
  const cwd = path.join(base, 'project'), data = path.join(base, 'data');
  fs.mkdirSync(cwd); fs.mkdirSync(data);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(cwd, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  let proposal = false, reasoningCalls = 0;
  const reasoner = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the bounded fixture request */ }
    if (request.method !== 'POST') { response.setHeader('Content-Type', 'application/json'); response.end('{"data":[]}'); return; }
    reasoningCalls++;
    const intent = proposal ? { kind: 'proposal', message: 'I suggest a documentation task.', brief: 'Improve docs.' }
      : { kind: 'handoff', message: 'I will hand off your request.', brief: 'Create the requested result.', threadId: 'untrusted-model-id', workers: ['untrusted-model-worker'], reviewCriteria: [] };
    response.setHeader('Content-Type', 'text/event-stream');
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(intent) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => reasoner.listen(0, '127.0.0.1', resolve));
  const profile = { id: 'assistant', display_name: 'Assistant', access: 'read', backend: { kind: 'open_ai_compatible', base_url: `http://127.0.0.1:${reasoner.address().port}/v1`, model: 'fixture', api_key_env: null } };
  let daemon = await serve(data);
  const connect = () => new DaemonClient(() => socketLink(path.join(data, 'daemon.sock')));
  let desktop = connect(), phone = connect();
  t.after(async () => { desktop.close(); phone.close(); await daemon.stop(); await new Promise(resolve => reasoner.close(resolve)); fs.rmSync(base, { recursive: true, force: true }); });
  await Promise.all([desktop.start(), phone.start()]);
  await desktop.call('room_create', { id: 'build-room', cwd, options, participants: [worker('worker', "sleep 0.5; printf 'requested result\\n' > result.txt; echo worker finished")] });
  const monitor = await desktop.call('monitor_assign', { workspaceId: 'project', cwd, hostId: 'local', text: 'Handle the project work I request', files: [], threads: [], profile });
  const owner = { workspaceId: 'project', cwd, hostId: 'local', conversationId: monitor.conversationId };
  await desktop.call('monitor_pause', { ...owner, paused: true });
  const events = [];
  phone.on('assistant-tasks-changed', event => events.push(event));
  const input = { ...owner, requestId: 'human-request-one', text: 'Please create the result in Build Room with @worker', destination: { threadId: 'build-room', workers: ['worker'], newThread: false }, newWorkerProfiles: [], threadLabels: [{ id: 'build-room', label: 'Build Room' }], mode: 'in_place', checks: [['sh', '-c', 'test -f result.txt']] };
  const response = await desktop.call('assistant_message', input);
  assert.equal(response.monitor.responsibility, monitor.responsibility, 'task conversation preserves periodic responsibility');
  assert.equal(response.task.originalRequest, input.text);
  assert.deepEqual(response.task.workers, ['worker'], 'model IDs confer no authority');
  const taskId = response.task.id;
  const list = async () => (await phone.call('assistant_tasks_list', { owner })).tasks.find(task => task.id === taskId);
  const running = await until('owned worker to start', async () => { const task = await list(); return task.status === 'running' && task.executionThreadId ? task : null; });
  await desktop.call('room_close', { id: running.executionThreadId });
  const ready = await until('detached worker result', async () => { const task = await list(); return task.status === 'ready_for_review' ? task : null; });
  assert.equal(ready.attempts.length, 1);
  assert.ok(ready.resultData.reviewDiff?.includes('result.txt'), JSON.stringify(ready.resultData));
  assert.equal(ready.resultData.leaseHeld, true);
  assert.ok(events.length, 'phone receives task events');
  const registry = await phone.call('assistant_tasks_list', { owner });
  assert.equal(registry.executions[0].pane.executionPath, cwd);
  await desktop.call('room_create', { id: 'other-writer', cwd, options, participants: [worker('other', "echo resumed > queued-writer.txt; echo resumed")] });
  const queuedWrite = desktop.call('room_post', { id: 'other-writer', text: '@other write' });
  await sleep(150);
  assert.equal(fs.existsSync(path.join(cwd, 'queued-writer.txt')), false, 'another Deck writer waits through review');
  const staged = fs.readFileSync(path.join(cwd, '.git/index'));
  await assert.rejects(phone.call('assistant_task_action', { taskId, owner, revision: ready.revision - 1, action: 'accept' }), /stale|changed|revision/i);
  const done = await phone.call('assistant_task_action', { taskId, owner, revision: ready.revision, action: 'accept' });
  assert.equal(done.status, 'done');
  assert.equal(done.resultData.leaseHeld, false);
  assert.deepEqual(fs.readFileSync(path.join(cwd, '.git/index')), staged);
  await queuedWrite;
  assert.equal(fs.readFileSync(path.join(cwd, 'queued-writer.txt'), 'utf8').trim(), 'resumed');
  desktop.close(); phone.close(); await daemon.stop();
  daemon = await serve(data); desktop = connect(); phone = connect(); await Promise.all([desktop.start(), phone.start()]);
  const restored = await list();
  assert.equal(restored.status, 'done'); assert.equal(restored.attempts.length, 1);
  const callsBefore = reasoningCalls;
  const replay = await desktop.call('assistant_message', input);
  assert.equal(replay.task.id, taskId); assert.equal(replay.task.status, 'done');
  assert.equal(reasoningCalls, callsBefore, 'replay returns durable receipt without another reasoning/worker turn');
  proposal = true;
  const suggested = await desktop.call('assistant_message', { ...input, requestId: 'human-question-two', text: 'What should we improve next?', destination: null });
  assert.equal(suggested.task.status, 'proposed'); assert.equal(suggested.task.executionThreadId, null);
  await sleep(100);
  assert.equal((await phone.call('assistant_tasks_list', { owner })).tasks.find(task => task.id === suggested.task.id).attempts.length, 0, 'a proactive suggestion waits for human approval');
});

test('two isolated workers keep approvals human-owned and integrate sequentially without changing staging', { timeout: 60_000 }, async t => {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/ade-isolated-'));
  const cwd = path.join(base, 'project'), data = path.join(base, 'data'), tools = path.join(base, 'tools');
  for (const directory of [cwd, data, tools]) fs.mkdirSync(directory);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(cwd, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  // A deterministic provider executable exercises the ordinary two-way
  // Claude adapter, its selected cwd and approval protocol without paid calls.
  fs.writeFileSync(path.join(tools, 'claude'), `#!/bin/sh
case "$*" in *--help*) echo 'The workspace trust dialog is skipped when stdout is not a TTY.'; exit 0;; esac
case "$*" in *bypassPermissions*) echo 'approval policy was broadened' >&2; exit 2;; esac
IFS= read -r prompt
case "$prompt" in *'task two'*) file=task-two.txt;; *) file=task-one.txt;; esac
echo '{"type":"system","subtype":"init"}'
printf '{"type":"control_request","request_id":"write-file","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"%s/%s","content":"worker result"}}}\\n' "$PWD" "$file"
IFS= read -r answer
case "$answer" in *'"behavior":"allow"'*) printf 'worker result\\n' > "$file";; *) exit 3;; esac
echo '{"type":"result","subtype":"success","is_error":false,"result":"Requested file created","usage":{"input_tokens":10,"output_tokens":4}}'
cat >/dev/null
`, { mode: 0o755 });
  const reasoner = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume fixture */ }
    if (request.method !== 'POST') { response.end('{"data":[]}'); return; }
    const intent = { kind: 'handoff', message: 'Delegating your request.', brief: 'Create the requested task file.', threadId: 'model-id', workers: ['model-worker'], reviewCriteria: [] };
    response.setHeader('Content-Type', 'text/event-stream');
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(intent) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => reasoner.listen(0, '127.0.0.1', resolve));
  let daemon, desktop, phone;
  t.after(async () => { desktop?.close(); phone?.close(); await daemon?.stop(); await new Promise(resolve => reasoner.close(resolve)); fs.rmSync(base, { recursive: true, force: true }); });
  // Disable the login-shell PATH override for this daemon only, so the fake
  // provider is guaranteed to be the executable under test.
  daemon = await serve(data, { PATH: `${tools}:${process.env.PATH}`, SHELL: '/bin/false' });
  desktop = new DaemonClient(() => socketLink(path.join(data, 'daemon.sock')));
  phone = new DaemonClient(() => socketLink(path.join(data, 'daemon.sock')));
  await Promise.all([desktop.start(), phone.start()]);
  const profile = { id: 'assistant', display_name: 'Assistant', access: 'read', backend: { kind: 'open_ai_compatible', base_url: `http://127.0.0.1:${reasoner.address().port}/v1`, model: 'fixture', api_key_env: null } };
  const monitor = await desktop.call('monitor_assign', { workspaceId: 'project', cwd, hostId: 'local', text: 'Handle requested project work', files: [], threads: [], profile });
  const owner = { workspaceId: 'project', cwd, hostId: 'local', conversationId: monitor.conversationId };
  await desktop.call('monitor_pause', { ...owner, paused: true });
  const worker = { id: 'claude', display_name: 'Claude fixture', access: 'ask', backend: { kind: 'agent', tool: 'claude_code', model: null } };
  const request = (word, filename) => ({ ...owner, requestId: `isolated-${word}`, text: `Please create the file for task ${word}`, destination: { threadId: null, newThread: true, workers: ['claude'] }, newWorkerProfiles: [worker], threadLabels: [], mode: 'isolated', checks: [['sh', '-c', `test -f ${filename}`]] });
  const [first, second] = await Promise.all([
    desktop.call('assistant_message', request('one', 'task-one.txt')),
    desktop.call('assistant_message', request('two', 'task-two.txt')),
  ]);
  const list = async () => (await phone.call('assistant_tasks_list', { owner })).tasks;
  const waiting = await until('both isolated workers awaiting human approval', async () => {
    const tasks = await list();
    return tasks.length === 2 && tasks.every(task => task.status === 'needs_you' && task.resultData.pendingApprovals?.length) ? tasks : null;
  }).catch(async error => { error.message += `: ${JSON.stringify(await list())}`; throw error; });
  assert.notEqual(waiting[0].resultData.executionPath, waiting[1].resultData.executionPath);
  for (const task of waiting) {
    assert.equal(task.mode, 'isolated'); assert.equal(task.resultData.leaseHeld, false);
    assert.notEqual(task.resultData.executionPath, cwd);
    assert.equal(fs.existsSync(path.join(cwd, 'task-one.txt')), false);
    assert.equal(fs.existsSync(path.join(cwd, 'task-two.txt')), false);
    const pending = task.resultData.pendingApprovals[0];
    await phone.call('room_decide', { id: task.executionThreadId, request: pending.request, approve: true, always: false });
  }
  const ready = await until('both isolated results ready', async () => { const tasks = await list(); return tasks.every(task => task.status === 'ready_for_review') ? tasks : null; });
  assert.ok(ready.every(task => task.resultData.reviewDiff.includes('task-')));
  fs.writeFileSync(path.join(cwd, 'human.txt'), 'staged human edit\n'); git('add', 'human.txt');
  const index = fs.readFileSync(path.join(cwd, '.git/index'));
  for (const id of [first.task.id, second.task.id]) {
    const task = (await list()).find(task => task.id === id);
    const done = await phone.call('assistant_task_action', { taskId: id, owner, revision: task.revision, action: 'accept' });
    assert.equal(done.status, 'done'); assert.equal(done.resultData.checkResults[0].success, true);
    assert.deepEqual(fs.readFileSync(path.join(cwd, '.git/index')), index);
    fs.writeFileSync(path.join(cwd, 'between.txt'), 'human edit between accepts\n');
  }
  assert.equal(fs.readFileSync(path.join(cwd, 'task-one.txt'), 'utf8'), 'worker result\n');
  assert.equal(fs.readFileSync(path.join(cwd, 'task-two.txt'), 'utf8'), 'worker result\n');
  assert.equal(fs.readFileSync(path.join(cwd, 'between.txt'), 'utf8'), 'human edit between accepts\n');
  const done = (await list()).find(task => task.id === first.task.id);
  const archived = await phone.call('assistant_task_action', { taskId: done.id, owner, revision: done.revision, action: 'archive' });
  assert.equal(archived.status, 'done'); assert.ok(archived.resultData.archivedAtMs);
  assert.equal(fs.existsSync(done.resultData.executionPath), false);
  assert.equal(git('cat-file', '-t', done.resultData.resultCommit).trim(), 'commit');
  await assert.rejects(phone.call('assistant_task_action', { taskId: done.id, owner, revision: archived.revision, action: 'retry' }), /archiv/i);
});


for (const hostCount of [1, 2]) {
  test(`cross-project proposals route on ${hostCount} isolated daemon host(s), recover receipts, and execute once`, { timeout: 90_000 }, async t => {
    const base = fs.realpathSync(fs.mkdtempSync('/tmp/ade-handoff-'));
    const hosts = [], projects = [];
    const tools = path.join(base, 'tools'); fs.mkdirSync(tools);
    fs.writeFileSync(path.join(tools, 'claude'), `#!/bin/sh
case "$*" in *--help*) echo 'The workspace trust dialog is skipped when stdout is not a TTY.'; exit 0;; esac
IFS= read -r prompt
case "$prompt" in *'project 0'*) number=0;; *) number=1;; esac
echo run >> '${base}/executions-'"$number"
echo '{"type":"system","subtype":"init"}'
sleep 0.3
printf 'project %s result\\n' "$number" > result.txt
echo '{"type":"result","subtype":"success","is_error":false,"result":"Project-local requested file created","usage":{"input_tokens":10,"output_tokens":4}}'
cat >/dev/null
`, { mode: 0o755 });
    const env = { PATH: `${tools}:${process.env.PATH}`, SHELL: '/bin/false' };
    let candidateAssignments = [];
    const reasoner = http.createServer(async (request, response) => {
      for await (const _chunk of request) { /* deterministic local model */ }
      if (request.method !== 'POST') { response.end('{"data":[]}'); return; }
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ message: 'Two scoped proposals await approval.', citations: [], assignments: candidateAssignments }) } }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise(resolve => reasoner.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      for (const host of hosts) { host.client?.close(); await host.daemon?.stop(); }
      await new Promise(resolve => reasoner.close(resolve)); fs.rmSync(base, { recursive: true, force: true });
    });
    const profile = { id: 'assistant', display_name: 'Assistant', access: 'read', backend: { kind: 'open_ai_compatible', base_url: `http://127.0.0.1:${reasoner.address().port}/v1`, model: 'fixture', api_key_env: null } };
    for (let i = 0; i < hostCount; i++) {
      const data = path.join(base, `data-${i}`); fs.mkdirSync(data);
      const host = { data, daemon: await serve(data, env) }; hosts.push(host);
      host.connect = async () => { host.client = new DaemonClient(() => socketLink(path.join(data, 'daemon.sock'))); await host.client.start(); };
      await host.connect();
    }
    for (let i = 0; i < 2; i++) {
      const host = hosts[i % hostCount], cwd = path.join(base, `project-${i}`), counter = path.join(base, `executions-${i}`);
      fs.mkdirSync(cwd);
      const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
      fs.writeFileSync(path.join(cwd, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
      const workspaceId = `project-${i}`, threadId = `room-${i}`, workerId = `worker-${i}`;
      await host.client.call('room_create', { id: threadId, cwd, options, participants: [{ id: workerId, display_name: workerId, access: 'ask', backend: { kind: 'agent', tool: 'claude_code', model: null } }] });
      const assigned = await host.client.call('monitor_assign', { workspaceId, cwd, hostId: 'local', text: 'Track requested work', files: [], threads: [], profile });
      const owner = { workspaceId, cwd, hostId: 'local', conversationId: assigned.conversationId };
      await host.client.call('monitor_pause', { ...owner, paused: true });
      const monitor = await host.client.call('monitor_get', { workspaceId });
      const assignment = { owner, revision: monitor.revision, brief: `Create project ${i} result`, destination: { threadId, workers: [workerId], newThread: false }, mode: 'isolated', reviewCriteria: [] };
      projects.push({ host, cwd, counter, owner, assignment });
    }
    candidateAssignments = projects.map(project => project.assignment);
    const originalRequest = 'Ask worker-0 to update project-0 and worker-1 to update project-1.';
    const overview = await hosts[0].client.call('assistant_overview', { owner: projects[0].owner, text: originalRequest, history: [], projects: projects.map(project => ({ ...project.owner, revision: project.assignment.revision, availability: 'online', routingThreads: [{ id: project.assignment.destination.threadId, workers: [{ id: project.assignment.destination.workers[0], display_name: project.assignment.destination.workers[0] }] }] })) });
    assert.deepEqual(overview.assignments, candidateAssignments);
    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      project.input = { ...overview.assignments[i], requestId: `child-${i}`, batchId: 'two-project-batch', originalRequest };
      if (i === 1) {
        // Drop the real daemon socket after it has persisted the proposal but
        // before DaemonClient receives its receipt. This is an uncertain write.
        let lostReplyId;
        const uncertain = new DaemonClient(async () => {
          const link = await socketLink(path.join(project.host.data, 'daemon.sock'));
          return { ...link,
            send(line) { const message = JSON.parse(line); if (message.cmd === 'assistant_handoff_prepare') lostReplyId = message.id; link.send(line); },
            onLine(callback) { link.onLine(line => { if (lostReplyId !== undefined && JSON.parse(line).id === lostReplyId) { link.close(); return; } callback(line); }); },
          };
        });
        await uncertain.start();
        try { await assert.rejects(uncertain.call('assistant_handoff_prepare', project.input), /lost|connection/i); }
        finally { uncertain.close(); }
      }
      project.task = (await project.host.client.call('assistant_handoff_prepare', project.input)).task;
      assert.equal(project.task.status, 'proposed'); assert.equal(project.task.attempts.length, 0); assert.equal(project.task.originalRequest, originalRequest);
      assert.equal(project.task.mode, 'isolated'); assert.equal(fs.existsSync(project.counter), false);
      const replay = await project.host.client.call('assistant_handoff_prepare', project.input);
      assert.equal(replay.task.id, project.task.id);
      for (const changed of [{ brief: 'Changed scope' }, { mode: 'read_only' }, { owner: projects[1 - i].owner }]) {
        await assert.rejects(project.host.client.call('assistant_handoff_prepare', { ...project.input, ...changed }), /different|changed|scope|payload|request|assignment/i);
      }
      await assert.rejects(project.host.client.call('assistant_handoff_prepare', { ...project.input, requestId: `stale-${i}`, revision: project.input.revision - 1 }), /stale|revision/i);
      await assert.rejects(project.host.client.call('assistant_handoff_prepare', { ...project.input, requestId: `unknown-${i}`, destination: { ...project.input.destination, workers: ['unknown'] } }), /unknown|worker/i);
      if (hostCount === 1) await assert.rejects(project.host.client.call('assistant_handoff_prepare', { ...project.input, requestId: `wrong-project-${i}`, destination: projects[1 - i].input?.destination ?? projects[1 - i].assignment.destination }), /outside|project/i);
    }
    // Persisted child receipts are recovered independently after a disconnected
    // destination. The coordinator's already prepared child is never recreated.
    const recoveredHost = hosts[hostCount - 1]; recoveredHost.client.close(); await recoveredHost.daemon.stop();
    recoveredHost.daemon = await serve(recoveredHost.data, env); await recoveredHost.connect();
    for (const project of projects) {
      const replay = await project.host.client.call('assistant_handoff_prepare', project.input);
      assert.equal(replay.task.id, project.task.id); assert.equal(replay.task.attempts.length, 0);
      if (hostCount === 2) {
        const otherHost = hosts.find(host => host !== project.host);
        await assert.rejects(otherHost.client.call('assistant_handoff_prepare', project.input), /unavailable|assignment|project/i);
      }
      const listed = await project.host.client.call('assistant_tasks_list', { owner: project.owner });
      assert.equal(listed.tasks.length, 1);
      await project.host.client.call('assistant_task_action', { taskId: replay.task.id, owner: project.owner, revision: replay.task.revision, action: 'approve', mode: 'isolated', destination: project.input.destination });
    }
    for (const project of projects) {
      const read = async () => (await project.host.client.call('assistant_tasks_list', { owner: project.owner })).tasks.find(task => task.id === project.task.id);
      const ready = await until('project-local isolated result', async () => { const task = await read(); return task.status === 'ready_for_review' ? task : null; }).catch(async error => { error.message += `: ${JSON.stringify(await read())}`; throw error; });
      assert.equal(ready.attempts.length, 1); assert.notEqual(ready.resultData.executionPath, project.cwd);
      assert.equal(fs.existsSync(path.join(project.cwd, 'result.txt')), false); assert.match(ready.resultData.reviewDiff, /result.txt/);
      const recovered = await project.host.client.call('assistant_handoff_prepare', project.input);
      assert.equal(recovered.task.id, ready.id); assert.equal(recovered.task.attempts.length, 1);
      await assert.rejects(project.host.client.call('assistant_task_action', { taskId: ready.id, owner: project.owner, revision: ready.revision - 1, action: 'accept' }), /stale|changed|revision/i);
      const done = await project.host.client.call('assistant_task_action', { taskId: ready.id, owner: project.owner, revision: ready.revision, action: 'accept' });
      assert.equal(done.status, 'done'); assert.equal(fs.readFileSync(project.counter, 'utf8'), 'run\n');
      assert.equal(fs.readFileSync(path.join(project.cwd, 'result.txt'), 'utf8'), `project ${projects.indexOf(project)} result\n`);
    }
  });
}
