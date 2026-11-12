import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import electron from 'electron';
import { runElectronScenario } from './helpers/electron-test.mjs';

// Exercise the main process's real menu without starting its daemon, windows,
// updater, or protected-install checks. Electron consumes this template next.
const source = fs.readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
const menuSource = source.match(/^function menu\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(menuSource, 'main process defines its application menu');

function fixture(platform, { packaged = true, updaterStarting = false } = {}) {
  const events = [];
  let focused = 'first';
  const template = vm.runInNewContext(`${menuSource}\nmenu()`, {
    app: { name: 'Apex Deck', isPackaged: packaged },
    process: { platform },
    Menu: { buildFromTemplate: (template) => template },
    frontWindow: () => ({ win: { webContents: { send: (channel, action) => events.push({ window: focused, channel, action }) } } }),
    updater: updaterStarting ? null : { check: (options) => {
      events.push({ manual: options.manual });
      // The Updates pane must open immediately while a check is pending.
      return new Promise(() => {});
    } },
  });
  return { template, events, focus: (name) => { focused = name; } };
}

const topMenu = (template, label) => template.find((item) => item.label === label);
const command = (menu, label) => menu?.submenu.find((item) => item.label === label);

test('Windows File menu exposes Settings and the native quit command', () => {
  const { template, events } = fixture('win32');
  const file = topMenu(template, 'File');
  assert.ok(file, 'Windows needs a File menu for app commands');
  const settings = command(file, 'Settings…');
  assert.ok(settings, 'Windows Settings must be available in the native menu');
  assert.equal(settings.accelerator, 'Ctrl+Shift+,');
  assert.ok(file.submenu.some((item) => item.role === 'quit'));
  settings.click();
  assert.deepEqual(events, [{ window: 'first', channel: 'menu', action: 'settings' }]);
});

test('Windows Help menu exposes About and checks updates before opening the existing Updates pane', () => {
  const { template, events } = fixture('win32');
  const help = topMenu(template, 'Help');
  assert.ok(help, 'Windows needs a Help menu for About and updates');
  assert.ok(help.submenu.some((item) => item.role === 'about'));
  const updates = command(help, 'Check for Updates…');
  assert.ok(updates, 'Windows update status must be reachable');
  updates.click();
  assert.deepEqual(events, [
    { manual: true },
    { window: 'first', channel: 'menu', action: 'updates' },
  ]);
});

test('Windows can open update status while the updater is still starting', () => {
  const { template, events } = fixture('win32', { updaterStarting: true });
  const updates = command(topMenu(template, 'Help'), 'Check for Updates…');
  assert.ok(updates);
  assert.doesNotThrow(() => updates.click());
  assert.deepEqual(events, [{ window: 'first', channel: 'menu', action: 'updates' }]);
});

test('macOS retains its app menu and existing Settings and Updates dispatch', () => {
  const { template, events, focus } = fixture('darwin');
  assert.deepEqual(Array.from(template, (item) => item.label ?? item.role), ['Apex Deck', 'Edit', 'View', 'Servers', 'windowMenu']);
  const appMenu = template[0];
  assert.deepEqual(Array.from(appMenu.submenu, (item) => item.role ?? item.label ?? item.type), [
    'about', 'Check for Updates…', 'separator', 'Settings…', 'separator',
    'services', 'separator', 'hide', 'hideOthers', 'unhide', 'separator', 'quit',
  ]);
  const settings = command(appMenu, 'Settings…');
  assert.equal(settings.accelerator, 'CmdOrCtrl+,');
  focus('second');
  settings.click();
  command(appMenu, 'Check for Updates…').click();
  assert.deepEqual(events, [
    { window: 'second', channel: 'menu', action: 'settings' },
    { manual: true },
    { window: 'second', channel: 'menu', action: 'updates' },
  ]);
});

for (const platform of ['darwin', 'win32']) {
  test(`${platform} retains shared edit, view, server, and window commands`, () => {
    for (const packaged of [false, true]) {
      const { template, events } = fixture(platform, { packaged });
      assert.deepEqual(Array.from(topMenu(template, 'Edit').submenu, (item) => item.role ?? item.type), [
        'undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll',
      ]);
      assert.deepEqual(Array.from(topMenu(template, 'View').submenu, (item) => item.role ?? item.type), [
        'reload', ...(!packaged ? ['toggleDevTools'] : []), 'separator',
        'resetZoom', 'zoomIn', 'zoomOut', 'separator', 'togglefullscreen',
      ]);
      assert.ok(template.some((item) => item.role === 'windowMenu'));
      command(topMenu(template, 'Servers'), 'Manage Servers…').click();
      assert.deepEqual(events, [{ window: 'first', channel: 'menu', action: 'hosts' }]);
    }
  });
}

test('Electron builds both platform menus and dispatches their existing pane commands', { timeout: 30000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-native-menu-'));
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const { app, Menu } = require('electron');
    const assert = require('node:assert/strict');
    const vm = require('node:vm');
    app.whenReady().then(() => {
      try {
        for (const platform of ['darwin', 'win32']) {
          const events = [];
          const built = vm.runInNewContext(${JSON.stringify(`${menuSource}\nmenu()`)} , {
            app: { name: 'Apex Deck', isPackaged: true },
            process: { platform }, Menu,
            frontWindow: () => ({ win: { webContents: { send: (channel, action) => events.push({ channel, action }) } } }),
            updater: { check: (options) => events.push({ manual: options.manual }) },
          });
          const owner = built.items.find(item => item.label === (platform === 'darwin' ? 'Apex Deck' : 'File'));
          const help = platform === 'darwin' ? owner : built.items.find(item => item.label === 'Help');
          assert.ok(owner.submenu.items.some(item => item.role === 'quit'));
          assert.ok(help.submenu.items.some(item => item.role === 'about'));
          const settings = owner.submenu.items.find(item => item.label === 'Settings…');
          assert.equal(settings.accelerator, platform === 'darwin' ? 'CmdOrCtrl+,' : 'Ctrl+Shift+,');
          settings.click();
          help.submenu.items.find(item => item.label === 'Check for Updates…').click();
          built.items.find(item => item.label === 'Servers').submenu.items.find(item => item.label === 'Manage Servers…').click();
          assert.deepEqual(events, [
            { channel: 'menu', action: 'settings' }, { manual: true },
            { channel: 'menu', action: 'updates' }, { channel: 'menu', action: 'hosts' },
          ]);
        }
        console.log('Native menu construction and pane dispatch passed for both templates');
        app.exit(0);
      } catch (error) { console.error(error.stack); app.exit(1); }
    });
  `);
  try {
    const result = await runElectronScenario(electron, main, temp, { timeoutMs: 20000, attempts: 1 });
    assert.equal(result.code, 0, result.output);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
