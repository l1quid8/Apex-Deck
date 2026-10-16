import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStartupState } from '../src/startupState.ts';
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('saved chats become ready while agent discovery is still pending, then receive its result', async () => {
  const discovery = deferred(); const updates = [];
  const saved = { version: 1, panes: [{ id: 'kept' }] };
  const backend = { machines: { discover: () => discovery.promise }, startupFolders: async () => ['/project'], sessionLoad: async () => saved, settingsLoad: async () => 'settings' };
  let ready = false;
  const loading = loadStartupState(backend, agents => updates.push(agents)).then(result => { ready = true; return result; });
  await tick();
  assert.equal(ready, true, 'agent detection must not block opening saved chats');
  assert.deepEqual(await loading, { folders: ['/project'], saved, savedSettings: { raw: 'settings' } });
  assert.deepEqual(updates, []);
  discovery.resolve([{ key: 'codex', found: true }]); await tick();
  assert.deepEqual(updates, [[{ key: 'codex', found: true }]]);
});

test('independent startup reads begin together and settings failure preserves the session', async () => {
  const folders = deferred(); const session = deferred(); const settings = deferred(); const called = [];
  const error = new Error('unreadable settings');
  const loading = loadStartupState({ detectAgents: async () => [], startupFolders: () => { called.push('folders'); return folders.promise; }, sessionLoad: () => { called.push('session'); return session.promise; }, settingsLoad: () => { called.push('settings'); return settings.promise; } }, () => {});
  await tick(); assert.deepEqual(called, ['folders', 'session', 'settings']);
  folders.resolve(['/project']); session.resolve({ panes: [] }); settings.resolve(Promise.reject(error));
  const result = await loading;
  assert.deepEqual(result.saved, { panes: [] }); assert.equal(result.savedSettings.error, error);
});

test('failed discovery is handled and does not prevent opening saved chats', async () => {
  const updates = [];
  const result = await loadStartupState({ detectAgents: async () => { throw Error('shell failed'); }, startupFolders: async () => { throw Error('no folders'); }, sessionLoad: async () => null, settingsLoad: async () => null }, agents => updates.push(agents));
  await tick(); assert.deepEqual(updates, [[]]); assert.deepEqual(result.folders, []); assert.equal(result.saved, null);
});
