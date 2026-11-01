import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const {transform} = createRequire(import.meta.url)('sucrase');

// Execute the actual SettingsPage event effect, without mocking its save logic.
function feedback(t) {
  const source = fs.readFileSync(new URL('../src/SettingsPage.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  // Listen for storage save errors');
  const end = source.indexOf('  const currentSec', start);
  const code = transform(source.slice(start, end), {transforms: ['typescript']}).code;
  const window = new EventTarget(), pendingOps = {current: new Map()}, idleTimer = {current: null};
  let state = 'idle', cleanup;
  const setSaveState = value => { state = typeof value === 'function' ? value(state) : value; };
  new Function('useEffect', 'pendingOps', 'idleTimer', 'setSaveState', 'window', code)(
    effect => { cleanup = effect(); }, pendingOps, idleTimer, setSaveState, window);
  t.after(() => cleanup?.());
  return {
    state: () => state,
    emit(kind, detail) { window.dispatchEvent(new CustomEvent(`settings-save-${kind}`, {detail})); },
    saved(detail) { window.dispatchEvent(new CustomEvent('settings-saved', {detail})); },
  };
}

test('cursor success cannot hide failed general settings persistence', t => {
  const f = feedback(t);
  f.emit('pending', {source: 'settings', seq: 2});
  f.emit('pending', {source: 'cursor', seq: 1});
  f.emit('error', {source: 'settings', seq: 2});
  f.saved({source: 'cursor', seq: 1});
  assert.equal(f.state(), 'error');
  f.emit('pending', {source: 'settings', seq: 3});
  assert.equal(f.state(), 'saving');
  f.saved({source: 'settings', seq: 3});
  assert.equal(f.state(), 'saved');
});

test('stale errors and acknowledgements cannot finish a newer operation', t => {
  const f = feedback(t);
  f.emit('pending', {source: 'settings', seq: 1});
  f.emit('pending', {source: 'settings', seq: 2});
  f.emit('error', {source: 'settings', seq: 1});
  assert.equal(f.state(), 'saving');
  f.saved({source: 'settings', seq: 1});
  assert.equal(f.state(), 'saving');
  f.saved({source: 'settings', seq: 2});
  assert.equal(f.state(), 'saved');
});

test('unversioned or unregistered completions never claim persistence', t => {
  const f = feedback(t);
  f.saved();
  assert.equal(f.state(), 'idle');
  f.emit('pending', {source: 'settings', seq: 5});
  f.saved({source: 'cursor', seq: 9});
  f.saved({source: 'settings'});
  f.saved({source: 'settings', seq: 6});
  assert.equal(f.state(), 'saving');
  f.saved({source: 'settings', seq: 5});
  assert.equal(f.state(), 'saved');
});
