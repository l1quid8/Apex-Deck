import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_BIN = path.join(repo, 'target/debug/apex-daemon-fixture');

function ensureFixtureDaemon() {
  if (!fs.existsSync(FIXTURE_BIN)) {
    execFileSync('cargo', ['build', '-p', 'apex-daemon', '--features', 'test-support', '--bin', 'apex-daemon-fixture'], {
      cwd: repo,
      env: { ...process.env, TMPDIR: '/tmp' },
      stdio: 'inherit',
    });
  }
  return FIXTURE_BIN;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, check, ms = 20_000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/**
 * Starts a throwaway `apex-daemon-fixture` in `/tmp`.
 * Note: `apex-daemon-fixture` is built with `test-support` and skips the root
 * provenance broker; this test proves the phone screens and daemon authority
 * table, while broker admission is tested in `crates/apex-provenance/tests/phone_admission.rs`.
 */
async function startDaemon(binPath, dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.rmSync(path.join(dataDir, 'daemon.json'), { force: true });
  const env = { ...process.env, TMPDIR: '/tmp' };
  // This fixture must never send policy or cursor updates to the installed helper.
  delete env.HOME;
  const child = spawn(binPath, ['serve', '--exit-on-stdin-close', '--data-dir', dataDir], {
    env,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  const info = await until('daemon.json', () => {
    if (exited !== null) throw new Error(`daemon exited (${exited}):\n${stderr}`);
    const file = path.join(dataDir, 'daemon.json');
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  });
  const token = await until('daemon-token', () => {
    const file = path.join(dataDir, 'daemon-token');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
  });
  return {
    port: info.port,
    token,
    dataDir,
    stop: () => new Promise((resolve) => {
      if (exited !== null) { resolve(); return; }
      child.once('exit', resolve);
      child.stdin.end();
    }),
  };
}

test('phone Machine page, Unified Computer Use, and App permissions work end-to-end against throwaway daemons', { timeout: 240_000 }, async (t) => {
  const baseBin = ensureFixtureDaemon();
  const rootTmp = fs.mkdtempSync('/tmp/phone-ucu-');
  // Fake app bundle layout so `bundle()` in apex-host reports `available: true` on macOS.
  const macBin = path.join(rootTmp, 'app', 'Contents', 'MacOS', 'apex-daemon-fixture');
  const helperPlaceholder = path.join(rootTmp, 'app', 'Contents', 'Resources', 'Unified Computer Use.app', 'Contents', 'Helpers', 'SpikeMCP');
  fs.mkdirSync(path.dirname(macBin), { recursive: true });
  fs.mkdirSync(path.dirname(helperPlaceholder), { recursive: true });
  fs.copyFileSync(baseBin, macBin);
  fs.chmodSync(macBin, 0o755);
  fs.writeFileSync(helperPlaceholder, '#!/bin/sh\n');

  const macData = path.join(rootTmp, 'mac-data');
  const linuxData = path.join(rootTmp, 'linux-data');
  const macDaemon = await startDaemon(macBin, macData);
  const linuxDaemon = await startDaemon(baseBin, linuxData);

  const viteTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-ucu-vite-'));
  const html = `<html><body><div id="root"></div><script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { PhoneApp } from '/src/phone/PhoneApp.tsx';
    import { PhoneAppPermissionsScreen, PhoneComputerUseScreen, usePhoneComputerStatus } from '/src/phone/ComputerUseSettings.tsx';
    import '/src/phone/phone.css';

    const params = new URLSearchParams(location.search);
    const macUrl = params.get('macUrl');
    const macToken = params.get('macToken');
    const linuxUrl = params.get('linuxUrl');
    const linuxToken = params.get('linuxToken');
    localStorage.setItem('apex-deck.phone.machines.v1', JSON.stringify([
      { id: 'local', name: 'MacBook Pro', kind: 'mac', url: macUrl, token: macToken },
      { id: 'linux-1', name: 'Linux Box', kind: 'server', url: linuxUrl, token: linuxToken },
    ]));

    const root = createRoot(document.getElementById('root'));
    window.mountApp = () => root.render(React.createElement(PhoneApp));

    // Controllable stand-in host for deterministic in-flight, refusal, and Ask save-failure checks.
    const ASK_NOT_SAVED = "Ask for each app is on now but couldn't be saved; it may switch back to Skip prompts after a restart.";
    const f = window.edgeFixture = {
      online: true,
      available: true,
      enabled: true,
      skip: false,
      warning: null,
      fail: 'none',
      hold: false,
      release: null,
      holdStatus: false,
      releaseStatus: null,
      failStatus: false,
      calls: [],
      status() { return { available: this.available, enabled: this.enabled, skipAppPrompts: this.skip, appPromptsWarning: this.warning }; },
    };
    function Sheet({ title, onClose, children }) {
      return React.createElement('div', { className: 'ph-sheet-back' },
        React.createElement('div', { className: 'ph-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          React.createElement('div', { className: 'ph-sheet-title' }, React.createElement('h3', null, title)),
          React.createElement('div', { className: 'ph-sheet-body' }, children),
        ),
      );
    }
    const edgeHost = {
      machine: { id: 'local', name: 'MacBook Pro', kind: 'mac' },
      connection: { get: () => ({ status: { kind: f.online ? 'connected' : 'disconnected' } }), subscribe: () => () => {} },
      backend: {
        async call(cmd, args) {
          if (cmd === 'computer_status') {
            if (f.failStatus) throw Error('This Mac cannot report computer use status.');
            const snapshot = f.status();
            if (f.holdStatus) await new Promise((resolve) => { f.releaseStatus = resolve; });
            return snapshot;
          }
          f.calls.push([cmd, args]);
          if (f.hold) await new Promise((resolve) => { f.release = resolve; });
          if (cmd === 'computer_set_app_prompts') {
            if (f.fail === 'refuse') throw Error('disk full');
            if (f.fail === 'askNotSaved' && !args.skip) {
              f.skip = false;
              f.warning = ASK_NOT_SAVED;
              throw Error(ASK_NOT_SAVED + ' disk full');
            }
            f.skip = args.skip;
            f.warning = null;
          }
          return f.status();
        },
      },
    };
    function EdgeHarness({ screen }) {
      const { status, statusError, setStatus, refresh } = usePhoneComputerStatus(edgeHost, f.online);
      window.edgeRefresh = refresh;
      return screen === 'ucu'
        ? React.createElement(PhoneComputerUseScreen, { machineName: 'MacBook Pro', host: edgeHost, online: f.online, status, statusError, onStatus: setStatus, onRefresh: refresh, onOpenAppPermissions: () => {} })
        : React.createElement(PhoneAppPermissionsScreen, { machineName: 'MacBook Pro', host: edgeHost, online: f.online, status, statusError, onStatus: setStatus, onRefresh: refresh, Sheet });
    }
    window.mountEdge = (screen) => root.render(React.createElement(EdgeHarness, { key: Math.random(), screen }));
    window.mountApp();
    window.ready = true;
  </script></body></html>`;

  const server = await createServer({
    cacheDir: path.join(viteTmp, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
    plugins: [{
      name: 'phone-ucu-test',
      configureServer(srv) {
        srv.middlewares.use('/__phone_ucu_test', async (req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end(await srv.transformIndexHtml(req.url ?? '/__phone_ucu_test', html));
        });
      },
    }],
  });
  await server.listen();

  const port = server.httpServer.address().port;
  const url = `http://127.0.0.1:${port}/__phone_ucu_test?macUrl=${encodeURIComponent(`ws://127.0.0.1:${macDaemon.port}`)}&macToken=${encodeURIComponent(macDaemon.token)}&linuxUrl=${encodeURIComponent(`ws://127.0.0.1:${linuxDaemon.port}`)}&linuxToken=${encodeURIComponent(linuxDaemon.token)}`;
  const main = path.join(viteTmp, 'main.cjs');

  t.after(async () => {
    await server.close();
    await Promise.all([macDaemon.stop(), linuxDaemon.stop()]);
    fs.rmSync(viteTmp, { recursive: true, force: true });
    fs.rmSync(rootTmp, { recursive: true, force: true });
  });

  fs.writeFileSync(main, `
    const { app, BrowserWindow } = require('electron');
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const macSettingsFile = ${JSON.stringify(path.join(macData, 'computer-enabled.json.protected-fixture'))};

    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: false, width: 420, height: 860, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
      win.webContents.on('console-message', (_e, _l, msg) => console.log(msg));
      const run = (fn, arg) => win.webContents.executeJavaScript('(' + fn.toString() + ')(' + JSON.stringify(arg ?? null) + ')');
      const wait = async (fn, label) => {
        for (let i = 0; i < 300; i++) {
          if (await win.webContents.executeJavaScript('Boolean((' + fn.toString() + ')())')) return;
          await new Promise((r) => setTimeout(r, 30));
        }
        throw new Error('Timed out: ' + label + '\\n' + await run(() => document.body.innerText));
      };
      const clickButton = (match) => run((m) => {
        const scope = document.querySelector('[role="dialog"]') || document;
        const buttons = [...scope.querySelectorAll('button')];
        const b = buttons.find((el) => el.textContent?.trim() === m) || buttons.find((el) => el.textContent && el.textContent.includes(m));
        if (!b) throw new Error('Button not found: ' + m + ' in: ' + buttons.map((x) => x.textContent).join(' | '));
        if (b.disabled) throw new Error('Button disabled: ' + b.textContent);
        b.click();
      }, match);
      const openAppPermissions = async () => {
        const ready = () => [...document.querySelectorAll('main button')]
          .some((b) => b.querySelector('strong')?.textContent === 'App permissions' && !b.disabled);
        await wait(ready, 'App permissions is enabled');
        await run(() => [...document.querySelectorAll('main button')]
          .find((b) => b.querySelector('strong')?.textContent === 'App permissions').click());
      };

      try {
        await win.loadURL(${JSON.stringify(url)});
        await wait(() => window.ready && document.querySelector('button[aria-label="Settings"]'), 'app ready');

        // Settings has NO General row; Code Mode lives on each machine's page.
        await run(() => document.querySelector('button[aria-label="Settings"]').click());
        await wait(() => document.querySelector('h2')?.textContent === 'Settings', 'Settings screen');
        const settingsButtons = await run(() => [...document.querySelectorAll('.ph-list button')].map((b) => b.textContent));
        assert.equal(settingsButtons.some((t) => /^General/.test(t)), false, 'General row is removed from Settings');
        assert.ok(settingsButtons.some((t) => t.includes('Machines')), 'Machines row is present');

        // Open Machines and wait until both throwaway daemons connect.
        await clickButton('Machines');
        await wait(() => document.querySelector('h2')?.textContent === 'Machines' && document.body.innerText.includes('MacBook Pro') && document.body.innerText.includes('Linux Box'), 'Machines list');
        await wait(() => [...document.querySelectorAll('.ph-dot.on')].length === 2, 'both daemons connected');

        // Linux host (available: false): Code Mode, Edit connection, Unpair present; NO UCU row.
        await clickButton('Linux Box');
        await wait(() => document.querySelector('h2')?.textContent.includes('Linux Box') && document.querySelector('select[aria-label="Apex Code Mode"]'), 'Linux machine page');
        await wait(() => !document.body.innerText.includes('Checking…'), 'Linux status settled');
        assert.equal(await run(() => document.body.innerText.includes('Unified Computer Use')), false, 'Linux host hides UCU row');
        assert.ok(await run(() => document.body.innerText.includes('Apex Code Mode')), 'Code Mode on machine page');
        assert.ok(await run(() => document.body.innerText.includes('Edit connection')), 'Edit connection on machine page');
        assert.ok(await run(() => document.body.innerText.includes('Unpair…')), 'Unpair on machine page');

        // Back to Machines -> MacBook Pro.
        await clickButton('Machines');
        await wait(() => document.querySelector('h2')?.textContent === 'Machines', 'back on Machines');
        await clickButton('MacBook Pro');
        await wait(() => document.querySelector('h2')?.textContent.includes('MacBook Pro') && document.body.innerText.includes('Unified Computer Use') && !document.body.innerText.includes('Checking…'), 'MacBook Pro machine page');
        assert.ok(await run(() => document.body.innerText.includes('Apex Code Mode')), 'Code Mode on Mac page');
        assert.ok(await run(() => document.body.innerText.includes('Edit connection')));
        assert.ok(await run(() => document.body.innerText.includes('Unpair…')));

        // Open Unified Computer Use -> no Stop/Stopped/Pause/Resume anywhere.
        await clickButton('Unified Computer Use');
        await wait(() => document.querySelector('h2')?.textContent === 'Unified Computer Use', 'UCU screen');
        const ucuInitial = await run(() => document.body.innerText);
        assert.doesNotMatch(ucuInitial, /Stop computer use|Resume computer use|Stopped|Pause/);

        // Turn Enable Unified Computer Use on against the real throwaway daemon.
        await run(() => document.querySelector('button[role="switch"][aria-label="Enable Unified Computer Use"]').click());
        await wait(() => document.querySelector('button[role="switch"][aria-label="Enable Unified Computer Use"]')?.getAttribute('aria-checked') === 'true', 'UCU enabled on real daemon');
        assert.equal(JSON.parse(fs.readFileSync(macSettingsFile, 'utf8')).enabled, true);

        // Open App permissions -> Ask for each app is selected.
        await openAppPermissions();
        await wait(() => document.querySelector('h2')?.textContent === 'App permissions', 'App permissions screen');
        const pressedLabel = () => run(() => document.querySelector('[role=group][aria-label="App permissions"] button[aria-pressed="true"] strong')?.textContent);
        assert.equal(await pressedLabel(), 'Ask for each app');

        // Tap Skip -> opens confirmation naming MacBook Pro and carrying all safety lines; Ask stays selected; Cancel changes nothing.
        await clickButton('Skip prompts for Full-access agents');
        await wait(() => document.querySelector('[role=dialog]'), 'Skip confirmation sheet');
        const dialogText = await run(() => document.querySelector('[role=dialog]').innerText);
        assert.match(dialogText, /Skip app prompts on MacBook Pro\\?/);
        assert.match(dialogText, /Protected apps/);
        assert.match(dialogText, /password fields/);
        assert.match(dialogText, /Stopping an agent.s output stops its computer use/);
        assert.match(dialogText, /model provider/);
        assert.equal(await run(() => getComputedStyle(document.querySelector('[role=dialog] h3')).whiteSpace), 'normal', 'confirmation title wraps to show the Mac name');
        assert.equal(await pressedLabel(), 'Ask for each app', 'Ask stays selected while confirmation is open');
        await clickButton('Cancel');
        await wait(() => !document.querySelector('[role=dialog]'), 'Cancel closes confirmation');
        assert.equal(await pressedLabel(), 'Ask for each app');

        // Confirm Skip prompts -> real throwaway daemon saves skipAppPrompts: true.
        await clickButton('Skip prompts for Full-access agents');
        await wait(() => document.querySelector('[role=dialog]'), 'confirmation reopens');
        await clickButton('Skip prompts');
        await wait(() => document.querySelector('[role=group][aria-label="App permissions"] button[aria-pressed="true"] strong')?.textContent === 'Skip prompts for Full-access agents', 'Skip confirmed by real daemon');
        assert.deepEqual(JSON.parse(fs.readFileSync(macSettingsFile, 'utf8')), { enabled: true, skipAppPrompts: true });

        // Back to Unified Computer Use -> On switch shows "Full-access agents skip app prompts."
        await clickButton('Unified Computer Use');
        await wait(() => document.querySelector('h2')?.textContent === 'Unified Computer Use', 'back to UCU screen');
        assert.match(await run(() => document.body.innerText), /Full-access agents skip app prompts\\./);

        // Turn UCU off and back on -> Skip survives and subtitle still says prompts are skipped.
        await run(() => document.querySelector('button[role="switch"][aria-label="Enable Unified Computer Use"]').click());
        await wait(() => document.querySelector('button[role="switch"][aria-label="Enable Unified Computer Use"]')?.getAttribute('aria-checked') === 'false', 'UCU turned off');
        assert.match(await run(() => document.body.innerText), /Full-access agents skip app prompts\\./);
        await run(() => document.querySelector('button[role="switch"][aria-label="Enable Unified Computer Use"]').click());
        await wait(() => document.querySelector('button[role="switch"][aria-label="Enable Unified Computer Use"]')?.getAttribute('aria-checked') === 'true', 'UCU turned back on');
        assert.match(await run(() => document.body.innerText), /Full-access agents skip app prompts\\./);
        assert.deepEqual(JSON.parse(fs.readFileSync(macSettingsFile, 'utf8')), { enabled: true, skipAppPrompts: true });

        // Switch back to Ask -> immediate, no confirmation, persisted on daemon.
        await openAppPermissions();
        await wait(() => document.querySelector('h2')?.textContent === 'App permissions', 'App permissions again');
        await clickButton('Ask for each app');
        await wait(() => document.querySelector('[role=group][aria-label="App permissions"] button[aria-pressed="true"] strong')?.textContent === 'Ask for each app', 'Ask confirmed');
        assert.equal(await run(() => document.querySelector('[role=dialog]')), null, 'no confirmation when switching to Ask');
        assert.deepEqual(JSON.parse(fs.readFileSync(macSettingsFile, 'utf8')), { enabled: true, skipAppPrompts: false });

        // Edge case 1: Checkmark stays on Ask while waiting for Mac reply and on failure.
        await run(() => { window.edgeFixture.hold = true; window.mountEdge('policy'); });
        await wait(() => document.querySelector('[aria-label="App permissions"] button:not(:disabled)'), 'edge policy loaded');
        await clickButton('Skip prompts for Full-access agents');
        await wait(() => document.querySelector('[role=dialog]'), 'edge confirm');
        await clickButton('Skip prompts');
        await wait(() => window.edgeFixture.calls.length === 1, 'in-flight call');
        assert.equal(await pressedLabel(), 'Ask for each app', 'checkmark stays on Ask while waiting for reply');
        await run(() => { window.edgeFixture.fail = 'refuse'; window.edgeFixture.hold = false; window.edgeFixture.release(); });
        await wait(() => document.querySelector('[role=alert]')?.textContent.includes('disk full'), 'failure shown');
        assert.equal(await pressedLabel(), 'Ask for each app', 'checkmark stays on Ask when reply fails');

        // Edge case 2: Ask takes effect on host but saving fails -> Ask selected + restart warning shown.
        await run(() => { window.edgeFixture.fail = 'askNotSaved'; window.edgeFixture.skip = true; window.edgeFixture.warning = null; window.mountEdge('policy'); });
        await wait(() => document.querySelector('[role=group][aria-label="App permissions"] button[aria-pressed="true"] strong')?.textContent === 'Skip prompts for Full-access agents', 'edge Skip loaded');
        await clickButton('Ask for each app');
        await wait(() => document.querySelector('[role=alert]')?.textContent.includes('may switch back to Skip prompts after a restart'), 'Ask restart warning shown');
        assert.equal(await pressedLabel(), 'Ask for each app', 'Ask is selected after host refresh');
        await run(() => window.mountEdge('policy'));
        await wait(() => document.querySelector('[role=alert]')?.textContent.includes('may switch back to Skip prompts after a restart'), 'restart warning survives reopening');
        assert.equal(await pressedLabel(), 'Ask for each app', 'Ask is selected after reopening');

        // A refresh that read Ask before the write completed cannot undo the acknowledged Skip.
        await run(() => {
          window.edgeFixture.fail = 'none';
          window.edgeFixture.holdStatus = true;
          window.edgePendingStatus = window.edgeRefresh();
        });
        await wait(() => window.edgeFixture.releaseStatus, 'old status response held');
        await clickButton('Skip prompts for Full-access agents');
        await wait(() => document.querySelector('[role=dialog]'), 'confirm Skip during refresh');
        await clickButton('Skip prompts');
        await wait(() => document.querySelector('[aria-pressed="true"] strong')?.textContent === 'Skip prompts for Full-access agents', 'Skip acknowledged while refreshing');
        await run(async () => {
          window.edgeFixture.holdStatus = false;
          window.edgeFixture.releaseStatus();
          await window.edgePendingStatus;
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        });
        assert.equal(await pressedLabel(), 'Skip prompts for Full-access agents', 'old refresh cannot undo acknowledged Skip');

        await run(() => { window.edgeFixture.failStatus = true; window.edgeRefresh(); });
        await wait(() => document.querySelector('[role=alert]')?.textContent.includes('cannot report computer use status'), 'status error shown');
        assert.equal(await run(() => [...document.querySelectorAll('[role=group][aria-label="App permissions"] button')].every((b) => b.disabled)), true);
        assert.equal(await pressedLabel(), undefined, 'no policy appears selected when its status is unknown');
        await run(() => { window.edgeFixture.failStatus = false; });
        await clickButton('Retry status');
        await wait(() => document.querySelector('[aria-pressed="true"] strong')?.textContent === 'Skip prompts for Full-access agents', 'status retry recovers the saved policy');

        // Edge case 3: Offline Mac shows "Reconnect to view or change app permissions."
        await run(() => { window.edgeFixture.online = false; window.mountEdge('ucu'); });
        await wait(() => document.body.innerText.includes('Reconnect to view or change app permissions.'), 'offline UCU message');
        assert.equal(await run(() => document.querySelector('button[role="switch"][aria-label="Enable Unified Computer Use"]').disabled), true);

        console.log('PHONE_COMPUTER_USE_OK');
        win.destroy();
        app.exit(0);
      } catch (err) {
        console.error(err.stack || err);
        win.destroy();
        app.exit(1);
      }
    });
  `);

  const result = await runElectronScenario(electron, main, viteTmp, { timeoutMs: 120_000 });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /PHONE_COMPUTER_USE_OK/);
});
