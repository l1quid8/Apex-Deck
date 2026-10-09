import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'sucrase';

const source = await fs.readFile(new URL('../src/HostPane.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/export function/g, 'function'), {
  transforms: ['typescript', 'jsx'], jsxRuntime: 'classic',
}).code;

function componentHarness(hostConnectionStore) {
  let refs = [], effects = [], cursor = 0;
  const timers = new Map(); let nextTimer = 0;
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
  const hooks = {
    useRef(initial) { const i = cursor++; return refs[i] ??= { current: initial }; },
    useSyncExternalStore(_subscribe, get) { cursor++; return get(); },
    useEffect(fn, deps) {
      const i = cursor++, prev = effects[i];
      if (!prev || !deps || deps.some((value, j) => !Object.is(value, prev.deps[j]))) {
        effects[i] = { fn, deps, changed: true, cleanup: prev?.cleanup };
      }
    },
  };
  const component = new Function('React', 'useRef', 'useSyncExternalStore', 'useEffect', 'ProjectMonitor', 'startHub', 'hostConnectionStore', 'setTimeout', 'clearTimeout', `${compiled}; return HostMonitors;`)(
    React, hooks.useRef, hooks.useSyncExternalStore, hooks.useEffect, {}, async () => () => {}, hostConnectionStore,
    setTimeoutFake, clearTimeoutFake,
  );
  let props;
  function render(nextProps = props) {
    props = nextProps; cursor = 0;
    const tree = component(props);
    for (const effect of effects) if (effect?.changed) {
      effect.changed = false; effect.cleanup?.(); effect.cleanup = effect.fn();
    }
    return tree;
  }
  function unmount() {
    for (const effect of effects) effect?.cleanup?.();
    timers.clear();
  }
  function setTimeoutFake(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }
  function clearTimeoutFake(id) { timers.delete(id); }
  return { render, unmount, timers };
}

function hostConnectionStore(hostId, name) {
  let current = { hostId, name, status: { kind: 'idle' }, revision: 0, agents: [], discovery: 'idle' };
  const listeners = new Set();
  return {
    get: () => current,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setStatus(status) {
      const refresh = (status.kind === 'connected' && current.revision === 0) || status.kind === 'resync';
      current = { ...current, status, revision: current.revision + (refresh ? 1 : 0) };
      listeners.forEach(listener => listener());
    },
    setDiscovery(discovery) {
      current = { ...current, discovery };
      listeners.forEach(listener => listener());
    },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const monitor = name => ({ projectId: name, responsibility: name });
const connected = (id = 'host-a') => ({ kind: 'connected', hostId: id });
const backendFor = (id, connection, call) => ({ host: { id, connection }, call });
const hostStore = (hostConnectionStore, id = 'host-a') => {
  const store = hostConnectionStore(id, id);
  store.setStatus(connected(id));
  return store;
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('a pending monitor snapshot from a disconnected host is ignored after reconnect', async () => {
  const oldReply = deferred(), currentReply = deferred(), callbacks = [];
  const store = hostStore(hostConnectionStore, 'host-a');
  let callCount = 0;
  const backend = backendFor('host-a', store, () => (++callCount === 1 ? oldReply.promise : currentReply.promise));
  const h = componentHarness(hostConnectionStore);
  const props = { backend, hostId: 'host-a', onMonitors: (...args) => callbacks.push(args) };

  h.render(props);
  store.setStatus({ kind: 'failed', reason: 'lost connection' });
  h.render(props);
  store.setStatus(connected('host-a'));
  h.render(props);
  currentReply.resolve([monitor('reconnected')]);
  await tick();
  oldReply.resolve([monitor('old connection')]);
  await tick();

  assert.deepEqual(callbacks, [['host-a', [monitor('reconnected')]]]);
  h.unmount();
});

test('a rapid disconnect and reconnect invalidates the old snapshot even when React misses the offline render', async () => {
  const oldReply = deferred(), currentReply = deferred(), callbacks = [];
  const store = hostStore(hostConnectionStore, 'host-a');
  let callCount = 0;
  const backend = backendFor('host-a', store, () => (++callCount === 1 ? oldReply.promise : currentReply.promise));
  const h = componentHarness(hostConnectionStore);
  const props = { backend, hostId: 'host-a', onMonitors: (...args) => callbacks.push(args) };

  h.render(props);
  store.setStatus({ kind: 'failed', reason: 'brief disconnect' });
  store.setStatus(connected('host-a'));
  h.render(props);
  currentReply.resolve([monitor('new connection')]);
  await tick();
  oldReply.resolve([monitor('old connection')]);
  await tick();

  assert.deepEqual(callbacks, [['host-a', [monitor('new connection')]]]);
  h.unmount();
});

test('an App version change rejects an already pending monitor snapshot', async () => {
  const reply = deferred(), callbacks = [];
  const store = hostStore(hostConnectionStore, 'host-a');
  const backend = backendFor('host-a', store, () => reply.promise);
  const h = componentHarness(hostConnectionStore);
  let version = 0;
  const props = () => ({ backend, hostId: 'host-a', getVersion: () => version, onMonitors: (...args) => callbacks.push(args) });

  h.render(props());
  version++;
  h.render(props());
  reply.resolve([monitor('stale')]);
  await tick();

  assert.deepEqual(callbacks, []);
  h.unmount();
});

test('ordinary host discovery updates do not invalidate a pending monitor snapshot', async () => {
  const reply = deferred(), callbacks = [];
  const store = hostStore(hostConnectionStore, 'host-a');
  const backend = backendFor('host-a', store, () => reply.promise);
  const h = componentHarness(hostConnectionStore);
  const props = { backend, hostId: 'host-a', onMonitors: (...args) => callbacks.push(args) };

  h.render(props);
  store.setDiscovery('ready');
  h.render(props);
  reply.resolve([monitor('snapshot')]);
  await tick();

  assert.deepEqual(callbacks, [['host-a', [monitor('snapshot')]]]);
  h.unmount();
});

test('failed or disconnected polling keeps the last successful attention snapshot', async () => {
  const pending = deferred(), callbacks = [];
  const store = hostStore(hostConnectionStore, 'host-a');
  let calls = 0;
  const backend = backendFor('host-a', store, () => (++calls === 1 ? Promise.resolve([monitor('attention')]) : pending.promise));
  const h = componentHarness(hostConnectionStore);
  let attention = [];
  const props = { backend, hostId: 'host-a', onMonitors: (_hostId, monitors) => { callbacks.push(monitors); attention = monitors; } };

  h.render(props);
  await tick();
  store.setStatus({ kind: 'failed', reason: 'offline' });
  h.render(props);
  pending.resolve([]);
  await tick();

  assert.deepEqual(callbacks, [[monitor('attention')]]);
  assert.deepEqual(attention, [monitor('attention')]);
  h.unmount();
});

test('replacing a backend for the same route host rejects the old backend reply', async () => {
  const oldReply = deferred(), newReply = deferred(), callbacks = [];
  const oldStore = hostStore(hostConnectionStore, 'host-a');
  const newStore = hostStore(hostConnectionStore, 'host-a');
  const oldBackend = backendFor('host-a', oldStore, () => oldReply.promise);
  const newBackend = backendFor('host-a', newStore, () => newReply.promise);
  const h = componentHarness(hostConnectionStore);
  const props = backend => ({ backend, hostId: 'host-a', onMonitors: (...args) => callbacks.push(args) });

  h.render(props(oldBackend));
  h.render(props(newBackend));
  newReply.resolve([monitor('replacement')]);
  await tick();
  oldReply.resolve([monitor('old backend')]);
  await tick();

  assert.deepEqual(callbacks, [['host-a', [monitor('replacement')]]]);
  h.unmount();
});
