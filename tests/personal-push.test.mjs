import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { transform } = require('sucrase');
const source = fs.readFileSync(new URL('../src/personalAssistant.ts', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript'] }).code;
const settle = () => new Promise(resolve => setImmediate(resolve));

/** Runs the real hook: state persists between renders, and effects re-run only when their dependencies change, as in React. */
function harness(args) {
  const states = [];
  const effects = [];
  let cursor = 0;
  const useState = (initial) => {
    const i = cursor++;
    if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
    return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
  };
  const useRef = (initial) => { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; };
  const useCallback = (fn) => { cursor++; return fn; };
  const useEffect = (effect, deps) => {
    const i = cursor++;
    const prev = effects[i];
    const changed = !prev || !deps || deps.some((dep, k) => !Object.is(dep, prev.deps[k]));
    if (changed) { prev?.cleanup?.(); effects[i] = { deps, cleanup: effect() }; }
  };
  const hook = new Function('useState', 'useRef', 'useCallback', 'useEffect', `${compiled}\nreturn usePersonalAssistant;`)(useState, useRef, useCallback, useEffect);
  return { render() { cursor = 0; return hook(args); } };
}

test('the phone asks for notifications once, sends its token to the assistant host, and a tap opens the assistant', async () => {
  const savedInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0; // the conversation poll is not under test
  const listeners = {};
  const push = {
    requested: 0, registered: 0,
    requestPermissions: async () => { push.requested += 1; return { receive: 'granted' }; },
    register: async () => { push.registered += 1; },
    addListener: async (event, callback) => { (listeners[event] ??= []).push(callback); return { remove() { listeners[event] = listeners[event].filter((item) => item !== callback); } }; },
  };
  globalThis.Capacitor = { Plugins: { PushNotifications: push } };
  const assistant = { id: 'asst-1', name: 'Assistant', hostId: 'vps', revision: 1, messages: [], tasks: [], timezone: 'UTC' };
  const calls = [];
  const backend = {
    call: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'personal_list') return [assistant];
      if (cmd === 'personal_push_register') return {};
      throw new Error(`unexpected ${cmd}`);
    },
  };
  let opened = 0;
  try {
    const h = harness({ hosts: [{ id: 'vps', name: 'VPS', remote: true }], hostBackend: () => backend, offlineHost: () => false, open: true, device: 'phone', onOpen: () => { opened += 1; } });
    for (let i = 0; i < 3; i += 1) { h.render(); await settle(); }
    assert.equal(push.requested, 1, 'permission is asked once, however many renders');
    assert.equal(push.registered, 1);
    listeners.registration.forEach((callback) => callback({ value: 'token-123' }));
    await settle();
    const registered = calls.filter(([cmd]) => cmd === 'personal_push_register').map(([, args]) => args);
    assert.deepEqual(registered, [{ assistantId: 'asst-1', token: 'token-123' }]);
    listeners.pushNotificationActionPerformed.forEach((callback) => callback({}));
    assert.equal(opened, 1, 'tapping a notification opens the assistant');
  } finally {
    globalThis.setInterval = savedInterval;
    delete globalThis.Capacitor;
  }
});
