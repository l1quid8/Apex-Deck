import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PopoutLayoutStore, fitPopoutBounds, trackPopoutWindow } from '../desktop/popoutLayout.mjs';
import { EventEmitter } from 'node:events';
import { parsePanel } from '../src/rightPanelModel.ts';

test('external browser tabs survive parsing without using the eight docked browser slots', () => {
  const tabs = [
    { id: 'external-browser', kind: 'browser', usedAt: 0, url: 'https://external.example' },
    ...Array.from({ length: 9 }, (_, i) => ({ id: `browser-${i}`, kind: 'browser', usedAt: i + 1 })),
  ];
  const restored = parsePanel(JSON.stringify({ tabs, active: 'external-browser' }), ['external-browser']);
  const browsers = restored.tabs.filter(tab => tab.kind === 'browser');
  assert.equal(browsers.length, 9);
  assert.equal(browsers[0].id, 'external-browser');
  assert.ok(!browsers.some(tab => tab.id === 'browser-0'));
  assert.equal(restored.active, 'external-browser');
});

const bounds = { x: 1500, y: 80, width: 900, height: 700 };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-popouts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'popout-layout.json');
}

test('external identities, normal bounds and maximized state survive a new process store', (t) => {
  const file = fixture(t);
  const store = new PopoutLayoutStore(file);
  store.set({ kind: 'pane', id: 'thread-1', bounds, maximized: true });
  store.set({ kind: 'tab', id: 'files', bounds, maximized: false });
  assert.deepEqual(new PopoutLayoutStore(file).list(), [
    { kind: 'pane', id: 'thread-1', bounds, maximized: true },
    { kind: 'tab', id: 'files', bounds, maximized: false },
  ]);
  store.remove('pane', 'thread-1');
  assert.deepEqual(new PopoutLayoutStore(file).list().map(r => r.id), ['files']);
});

test('restoration drops deleted panes and tabs and keeps only one window per identity', (t) => {
  const file = fixture(t);
  const store = new PopoutLayoutStore(file);
  store.set({ kind: 'pane', id: 'deleted', bounds });
  store.set({ kind: 'pane', id: 'kept', bounds });
  store.set({ kind: 'pane', id: 'kept', bounds: { ...bounds, x: 200 } });
  store.set({ kind: 'tab', id: 'files', bounds });
  assert.deepEqual(store.restore({ panes: ['kept'], tabs: [] }), [{ kind: 'pane', id: 'kept' }]);
  assert.equal(new PopoutLayoutStore(file).list().length, 1);
});

test('damaged saves and invalid geometry cannot create windows', (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(new PopoutLayoutStore(file).list(), []);
  fs.writeFileSync(file, JSON.stringify([
    { kind: 'pane', id: 'ok', bounds },
    { kind: 'pane', id: 'bad', bounds: { ...bounds, x: null } },
    { kind: 'unknown', id: 'bad-kind', bounds },
    { kind: 'tab', id: 'zero', bounds: { ...bounds, height: 0 } },
  ]));
  assert.deepEqual(new PopoutLayoutStore(file).list().map(r => r.id), ['ok']);
});

test('missing displays and changed work areas keep the whole window reachable', () => {
  const screens = [{ x: 0, y: 25, width: 1440, height: 875 }];
  assert.deepEqual(fitPopoutBounds(bounds, screens), { x: 540, y: 80, width: 900, height: 700 });
  assert.deepEqual(fitPopoutBounds({ x: -2000, y: -1000, width: 3000, height: 2000 }, screens),
    { x: 0, y: 25, width: 1440, height: 875 });
  const left = { x: -1920, y: 0, width: 1920, height: 1080 };
  const onLeft = { x: -1800, y: 70, width: 800, height: 600 };
  assert.deepEqual(fitPopoutBounds(onLeft, [screens[0], left]), onLeft);
});

function fakeWindow() {
  const win = new EventEmitter();
  win.bounds = { ...bounds };
  win.maximized = false;
  win.getNormalBounds = () => win.bounds;
  win.isMaximized = () => win.maximized;
  win.isDestroyed = () => false;
  return win;
}

test('window moves persist before shutdown and quitting retains the open layout', (t) => {
  const file = fixture(t);
  const store = new PopoutLayoutStore(file);
  const win = fakeWindow();
  let quitting = false;
  trackPopoutWindow(win, { kind: 'pane', id: 'thread' }, store, () => quitting);
  win.bounds = { x: 120, y: 100, width: 700, height: 500 };
  win.emit('move');
  win.maximized = true;
  win.emit('maximize');
  assert.deepEqual(new PopoutLayoutStore(file).list(), [{ kind: 'pane', id: 'thread', bounds: win.bounds, maximized: true }]);
  quitting = true;
  win.emit('closed');
  assert.equal(new PopoutLayoutStore(file).list().length, 1);
});

test('closing or returning an external window removes it from the next boot layout', (t) => {
  const file = fixture(t);
  const store = new PopoutLayoutStore(file);
  const win = fakeWindow();
  trackPopoutWindow(win, { kind: 'tab', id: 'files' }, store, () => false);
  win.emit('closed');
  assert.deepEqual(new PopoutLayoutStore(file).list(), []);
});
