import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('Electron fixtures keep requested content bounds and explicitly test both motion preferences', { timeout: 30000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-fixture-environment-'));
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const { app, BrowserWindow } = require('electron');
    const assert = require('node:assert/strict');
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show:false, width:1600, height:1000, useContentSize:true, enableLargerThanScreen:true, webPreferences:{ offscreen:true, backgroundThrottling:false } });
      const run = code => win.webContents.executeJavaScript(code);
      try {
        assert.ok(app.commandLine.hasSwitch('force-prefers-no-reduced-motion'), 'the fixture preference is explicit rather than inherited from the desktop');
        await win.loadURL('data:text/html,<html><body>Fixture environment</body></html>');
        assert.deepEqual(win.getContentSize(), [1600,1000], 'native fixture dimensions must not be clipped to the runner desktop');
        assert.deepEqual(await run('[innerWidth,innerHeight]'), [1600,1000], 'renderer dimensions must match the requested content bounds');
        const reduced = () => run('matchMedia("(prefers-reduced-motion: reduce)").matches');
        assert.equal(await reduced(), false, 'ordinary motion scenarios explicitly use normal motion');
        win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:'reduce'}] });
        assert.equal(await reduced(), true, 'accessibility scenarios can still request reduced motion');
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features:[] });
        assert.equal(await reduced(), false, 'clearing the override restores the fixture preference');
        win.destroy(); app.exit(0);
      } catch (error) { console.error(error); win.destroy(); app.exit(1); }
    });
  `);
  try {
    const result = await runElectronScenario(electron, main, temp, { timeoutMs:20000, attempts:1 });
    assert.equal(result.code, 0, result.output);
  } finally {
    fs.rmSync(temp, { recursive:true, force:true, maxRetries:5, retryDelay:100 });
  }
});
