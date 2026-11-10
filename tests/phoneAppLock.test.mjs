import test from 'node:test';
import assert from 'node:assert/strict';
import { Capacitor } from '@capacitor/core';

// The lock is native (iphone/App/App/AppLock.swift); this covers the web side of it — the switch in
// Settings and what the app reports. The bridge is faked at the same seam a real iPhone uses
// (PluginHeaders + nativePromise/nativeCallback), so the plugin proxy is the production one.

const listeners = {};
const removed = [];
let answers = {};

Capacitor.PluginHeaders = [{
  name: 'ApexLock',
  methods: [
    { name: 'status', rtype: 'promise' },
    { name: 'setEnabled', rtype: 'promise' },
    { name: 'unlock', rtype: 'promise' },
    { name: 'addListener', rtype: 'callback' },
    { name: 'removeListener', rtype: 'callback' },
  ],
}];
Capacitor.nativePromise = async (plugin, method, options) => {
  assert.equal(plugin, 'ApexLock');
  const answer = answers[method];
  if (answer instanceof Error) throw answer;
  return typeof answer === 'function' ? answer(options) : answer;
};
Capacitor.nativeCallback = async (plugin, method, options, callback) => {
  if (method === 'addListener') listeners[options.eventName] = callback;
  else if (method === 'removeListener') removed.push(options);
  return 1;
};

const { lockPresent, lockStatus, setLockEnabled, unlockApp, watchLock, NO_LOCK } = await import('../src/phone/appLock.ts');

const withoutPlugin = (t) => {
  const headers = Capacitor.PluginHeaders;
  Capacitor.PluginHeaders = [];
  t.after(() => { Capacitor.PluginHeaders = headers; });
};

test('a build with no lock in it is reported as no lock, never as an unlocked app', async t => {
  withoutPlugin(t);
  assert.equal(lockPresent(), false);
  assert.deepEqual(await lockStatus(), NO_LOCK);
  assert.deepEqual(await setLockEnabled(true), NO_LOCK);
  assert.equal(await unlockApp(), true, 'nothing to unlock, so nothing is held');
  assert.equal(typeof await watchLock(() => {}), 'function', 'watching must be safe to call anywhere');
});

test('the status the native side gives is the status the switch shows', async t => {
  answers = { status: { enabled: true, locked: true, available: true } };
  assert.equal(lockPresent(), true);
  assert.deepEqual(await lockStatus(), { enabled: true, locked: true, available: true });
});

test('only a real boolean counts as on', async t => {
  // A plugin that answers something else must not be able to make the app believe it is protected.
  answers = { status: { enabled: 'yes', locked: 1, available: {} } };
  assert.deepEqual(await lockStatus(), { enabled: false, locked: false, available: false });
});

test('turning the switch on sends the choice and reports what the phone did', async t => {
  let asked = null;
  answers = { setEnabled: (options) => { asked = options; return { enabled: true, available: true }; } };
  assert.deepEqual(await setLockEnabled(true), { enabled: true, locked: false, available: true });
  assert.deepEqual(asked, { enabled: true });
  answers = { setEnabled: () => ({ enabled: false, available: false }) };
  assert.deepEqual(await setLockEnabled(true), { enabled: false, locked: false, available: false }, 'a phone with no passcode stays unlocked and says so');
});

test('a failing native call is reported as no lock instead of throwing at the switch', async t => {
  answers = { status: new Error('bridge gone'), setEnabled: new Error('bridge gone'), unlock: new Error('bridge gone') };
  assert.deepEqual(await lockStatus(), NO_LOCK);
  assert.deepEqual(await setLockEnabled(false), NO_LOCK);
  assert.equal(await unlockApp(), false);
});

test('unlocking by hand tells the caller whether the app opened', async t => {
  answers = { unlock: () => ({ unlocked: true, locked: false }) };
  assert.equal(await unlockApp(), true);
  answers = { unlock: () => ({ unlocked: false, locked: true }) };
  assert.equal(await unlockApp(), false, 'a cancelled scan leaves it locked');
});

test('the phone locking itself reaches the screen, and unsubscribing stops it', async t => {
  answers = {};
  const seen = [];
  const stop = await watchLock((status) => seen.push(status));
  listeners.lockChanged({ enabled: true, locked: true, available: true });
  listeners.lockChanged({ enabled: true, locked: false, available: true });
  assert.deepEqual(seen, [
    { enabled: true, locked: true, available: true },
    { enabled: true, locked: false, available: true },
  ]);
  await stop();
  assert.equal(removed.length, 1, 'the native listener is removed too, not just ignored');
  assert.equal(removed[0].eventName, 'lockChanged');
});
