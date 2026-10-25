import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { DaemonClient } from '../../src/daemon/client.ts';
import { socketLink } from './link.mjs';
import { createRequire } from 'node:module';
import { identiconCells } from '../../src/identicon.ts';
import { REFILL_STAGGER_MS } from '../../src/battery.ts';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function eventually(label, read, timeout = 20_000) {
  const end = Date.now() + timeout;
  let last;
  do { last = await read(); if (last) return last; await delay(25); } while (Date.now() < end);
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

// Register cleanup before the first asynchronous startup operation. Every store,
// executable, checkout, model endpoint and socket belongs to this disposable root.
export async function workspaceFixture(t, prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(`/tmp/${prefix}-`));
  const hosts = [], clients = new Set();
  const server = http.createServer(async (request, response) => {
    for await (const _ of request) { /* consume fixture prompt */ }
    if (request.method !== 'POST') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'fixture-text', object: 'model' }] }));
    } else {
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ reply: 'Recorded your project request.' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`);
    }
  });
  t.after(async () => {
    for (const client of clients) client.close();
    for (const host of hosts) await host.stop();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = { id: 'source-agents-profile', display_name: 'Reusable source', access: 'full', effort: null, backend: { kind: 'open_ai_compatible', base_url: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture-text', api_key_env: null } };
  const tools = path.join(root, 'tools'); fs.mkdirSync(tools);
  async function host(name) {
    const data = path.join(root, name); fs.mkdirSync(data);
    const state = { data, clients: new Set(), child: undefined, error: '', exit: undefined };
    state.stop = async () => {
      for (const client of state.clients) { client.close(); clients.delete(client); }
      state.clients.clear();
      const child = state.child;
      if (!child || state.exit !== undefined) return;
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end();
      if (!await Promise.race([stopped.then(() => true), delay(5000).then(() => false)])) { child.kill('SIGKILL'); await stopped; }
    };
    state.connect = async () => {
      const client = new DaemonClient(() => socketLink(path.join(data, 'daemon.sock')), { delay: () => 60_000 });
      clients.add(client); state.clients.add(client);
      const welcome = await client.start();
      state.client = client; state.hostId = welcome.host_id;
      return client;
    };
    state.start = async () => {
      fs.rmSync(path.join(data, 'daemon.json'), { force: true });
      state.exit = undefined; state.error = '';
      const binary = process.env.APEX_DAEMON_BIN ?? path.resolve('target/debug/apex-daemon-fixture');
      state.child = spawn(binary, ['serve', '--exit-on-stdin-close', '--data-dir', data], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, SHELL: '/bin/false' } });
      state.child.on('error', error => { state.error += error.message; state.exit = -1; });
      state.child.on('exit', code => { state.exit = code; });
      state.child.stderr.on('data', bytes => { state.error += bytes; });
      await eventually(`${name} startup`, () => {
        if (state.exit !== undefined) throw new Error(state.error);
        return fs.existsSync(path.join(data, 'daemon.json'));
      });
      await state.connect();
    };
    hosts.push(state); await state.start(); return state;
  }
  function project(name) {
    const cwd = path.join(root, name); fs.mkdirSync(cwd);
    const git = (...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(cwd, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
    assert.equal(cwd, fs.realpathSync(cwd));
    return cwd;
  }
  return { root, host, profile, project, tools };
}

export const readAssistant = (host, id = 'asst-1') => host.client.call('personal_get', { assistantId: id });
export const ref = assistant => ({ hostId: assistant.hostId, assistantId: assistant.id });
export async function configure(host, id, input) {
  return eventually('revision-bound assistant configuration', async () => {
    const current = await readAssistant(host, id);
    try { return (await host.client.call('personal_workspace_configure', { assistantId: id, expectedRevision: current.revision, ...input })).assistant; }
    catch (error) { if (/changed|revision/i.test(error.message)) return false; throw error; }
  });
}

// Exercise the production component with a saved record and a failing fetch.
// This small hook driver has no DOM or screenshot dependency; all drawing and
// fallback decisions still come from Avatar.tsx and the shared identicon code.
export async function assertOfflinePixelFallback(assistant, asset) {
  const { transform } = createRequire(import.meta.url)('sucrase');
  const source = fs.readFileSync(new URL('../../src/Avatar.tsx', import.meta.url), 'utf8');
  const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
  const states = [], effects = []; let cursor = 0;
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
  const useState = initial => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; };
  const Avatar = new Function('React', 'useMemo', 'useRef', 'useState', 'useEffect', 'identiconCells', 'REFILL_STAGGER_MS', `${compiled}; return Avatar;`)(React, fn => fn(), value => ({ current: value }), useState, fn => effects.push(fn), identiconCells, REFILL_STAGGER_MS);
  const props = { seed: assistant.look.seed, color: assistant.look.color, assistant: ref(assistant), image: asset, avatarApi: { asset: async () => { throw new Error('host offline'); } } };
  cursor = 0; Avatar(props);
  const cleanups = effects.map(effect => effect());
  await new Promise(resolve => setImmediate(resolve));
  cursor = 0; const tree = Avatar(props);
  assert.equal(tree.type, 'span'); assert.equal(tree.props.style['--who'], assistant.look.color);
  assert.equal(tree.children.length, 25);
  assert.deepEqual(tree.children.map(cell => cell.props.className === 'on'), identiconCells(assistant.look.seed).map(cell => cell.on));
  cleanups.forEach(cleanup => cleanup?.());
}
