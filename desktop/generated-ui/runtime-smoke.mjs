// Run directly with `node node_modules/electron/cli.js desktop/generated-ui/runtime-smoke.mjs`.
// This standalone test process does not start Deck, its daemon, or a build.
// Passing these probes is scoped evidence, never packaged release approval.
import { app, BrowserWindow, ipcMain, session, WebContentsView, webContents } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGeneratedUIManager } from './host.mjs';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-generated-probes-'));
app.setPath('userData', profile);
app.setName('Deck Generated UI Probe');
const evidence = {
  packaged: app.isPackaged, versions: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
  releaseEnabled: false, testOnlyPolicy: true, observations: [], probes: [],
  pendingReleaseGates: ['actual packaged runtime', 'independent network and authoritative DNS/UDP/TCP capture with positive control', 'Connection-Allowlist inheritance', 'full escape/authority matrix', 'multiple windows and full UI lifecycle', 'independent security review'],
};
const events = [];
const now = () => Date.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, timeout = 8000) => {
  const until = now() + timeout;
  while (now() < until) { const value = predicate(); if (value) return value; await sleep(25); }
  throw new Error('Runtime probe timed out.');
};
let win;
let manager;
let renewing;
const receive = (event, value) => manager?.receive(event, value);
async function probe() {
try {
  win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL('data:text/html,<title>Trusted probe chat</title><p id="chat">chat alive</p>');
  const electron = { app, session, WebContentsView, webContents };
  const closed = createGeneratedUIManager({ electron, emit() {} });
  assert.equal(closed.capability().enabled, false);
  await assert.rejects(closed.run({ win, frame: win.webContents.mainFrame }, {}), /disabled/);
  const chatPid = win.webContents.getOSProcessId();
  manager = createGeneratedUIManager({
    electron, testPolicy: { testOnly: true, enabled: true, ledger: { count: 0 } },
    emit(_win, event) { events.push({ at: now(), ...event }); },
    audit(event) { evidence.observations.push({ at: now(), ...event }); },
  });
  ipcMain.on('generated-ui:message', receive);
  const owner = { win, frame: win.webContents.mainFrame };
  const bounds = { x: 20, y: 80, width: 700, height: 300 };
  let current;
  renewing = setInterval(() => { if (current) manager.bounds(owner, current.runId, bounds); }, 100);
  const run = async (id, js) => {
    const card = { schemaVersion: 1, kind: 'generated', cardId: id, title: id, summary: 'Runtime probe', html: '<button id="button">Local control</button><output id="out">0</output>', css: '', js, fallback: 'Standalone runtime probe.' };
    current = await manager.run(owner, { requestId: `${id}-${'request'.repeat(4)}`, source: JSON.stringify(card), identity: { threadId: 'probe', seq: 1, cardId: id, hostId: 'local' }, bounds });
    return current;
  };
  const stopped = async result => {
    const event = await waitFor(() => events.find(event => event.runId === result.runId && event.type === 'stopped'), 10000);
    const disposal = evidence.observations.find(event => event.type === 'disposed' && event.runId === result.runId);
    assert.deepEqual(disposal.remaining, [], 'all recorded generated PIDs exited');
    assert.equal(win.webContents.getOSProcessId(), chatPid, 'trusted chat retained its renderer');
    assert.equal(await win.webContents.executeJavaScript('document.getElementById("chat").textContent'), 'chat alive');
    current = null;
    return event;
  };
  const local = await run('local', 'let n = 0; document.getElementById("button").onclick = () => { document.getElementById("out").textContent = String(++n); }; setTimeout(() => generatedUI.discuss("local script executed"), 50);');
  await waitFor(() => events.find(event => event.runId === local.runId && event.type === 'ready'));
  await waitFor(() => events.find(event => event.runId === local.runId && event.type === 'discuss'));
  const trace = evidence.observations.filter(event => event.runId === local.runId);
  assert.ok(trace.findIndex(event => event.type === 'ownership-verified') < trace.findIndex(event => event.type === 'payload-delivered'));
  const pids = trace.find(event => event.type === 'ownership-verified').records.map(record => record.pid);
  assert.ok(pids.length >= 1 && pids.every(pid => pid !== chatPid));
  const generatedPage = webContents.getAllWebContents().find(page => page.getURL().endsWith(local.runId));
  const generatedChild = generatedPage.mainFrame.framesInSubtree.find(frame => frame.url === 'about:srcdoc');
  assert.equal(await generatedChild.executeJavaScript('document.getElementById("button").click(); document.getElementById("out").textContent'), '1');
  // A wrong Deck owner cannot stop or reposition this run.
  await manager.stop({ win, frame: {} }, local.runId);
  manager.bounds({ win, frame: {} }, local.runId, null);
  assert.ok(!events.find(event => event.runId === local.runId && event.type === 'stopped'));
  await manager.stop(owner, local.runId);
  await stopped(local);
  evidence.probes.push({ name: 'renderer separation, ownership-before-delivery, explicit owner stop', passed: true, chatPid, generatedPids: pids });

  const requestId = 'cancel-before-init-request-0001';
  const cancelledCard = { schemaVersion: 1, kind: 'generated', cardId: 'cancelled', title: 'Cancelled', summary: 'Cancellation probe', html: '<p>Never execute</p>', css: '', js: 'while (true) {}', fallback: 'Cancelled probe.' };
  const pending = manager.run(owner, { requestId, source: JSON.stringify(cancelledCard), identity: { threadId: 'probe', seq: 1, cardId: 'cancelled', hostId: 'local' }, bounds });
  void pending.catch(() => {});
  await manager.cancel(owner, requestId);
  await assert.rejects(pending);
  const cancelledEvent = events.find(event => event.type === 'stopped' && /cancelled/.test(event.reason));
  assert.ok(cancelledEvent);
  assert.equal(evidence.observations.filter(event => event.runId === cancelledEvent.runId && event.type === 'payload-delivered').length, 0);
  assert.equal(webContents.getAllWebContents().filter(page => page.getURL().startsWith('https://generated-ui.invalid/')).length, 0);
  evidence.probes.push({ name: 'cancel before bootstrap prevents payload delivery and removes native host', passed: true });

  for (const fixture of [
    { id: 'sync-loop', js: 'while (true) {}', ready: false },
    { id: 'initialization-error', js: 'throw new Error("Initialization failed");', ready: false },
    { id: 'after-ready', js: 'setTimeout(() => { while (true) {} }, 50);', ready: true },
    { id: 'microtask-loop', js: 'setTimeout(() => { const loop = () => Promise.resolve().then(loop); loop(); }, 50);', ready: true },
  ]) {
    const started = now();
    const result = await run(fixture.id, fixture.js);
    if (fixture.ready) await waitFor(() => events.find(event => event.runId === result.runId && event.type === 'ready'));
    const event = await stopped(result);
    assert.match(event.reason, fixture.ready ? /stopped responding/ : /two seconds/);
    evidence.probes.push({ name: fixture.id, passed: true, elapsedMs: now() - started, reason: event.reason });
  }
  const stale = await run('stale-geometry', '');
  await waitFor(() => events.find(event => event.runId === stale.runId && event.type === 'ready'));
  current = null; // Stop renewing the main-owned geometry lease.
  const staleEvent = await stopped(stale);
  assert.match(staleEvent.reason, /geometry expired/);
  evidence.probes.push({ name: 'stale geometry detaches and disposes', passed: true });
  const storm = await run('invalid-message-storm', 'addEventListener("message", event => { if (event.data?.type === "ping") for (let i = 0; i < 100; i++) parent.postMessage({ type: "invalid" }, "*"); });');
  await waitFor(() => events.find(event => event.runId === storm.runId && event.type === 'ready'));
  const stormEvent = await stopped(storm);
  assert.match(stormEvent.reason, /too many messages/);
  evidence.probes.push({ name: 'malformed child message storm is stopped by trusted wrapper', passed: true });
  const atLimit = createGeneratedUIManager({ electron, emit() {}, testPolicy: { testOnly: true, enabled: true, ledger: { count: 32 } } });
  await assert.rejects(atLimit.run(owner, {}), /session limit/);
  evidence.probes.push({ name: 'lifetime partition cap', passed: true });
  evidence.passed = true;
} catch (error) {
  evidence.passed = false; evidence.error = error.stack ?? String(error);
} finally {
  clearInterval(renewing);
  ipcMain.removeListener('generated-ui:message', receive);
  await manager?.stopAll('Probe complete.');
  if (win && !win.isDestroyed()) win.destroy();
  const outputArg = process.argv.indexOf('--output');
  if (outputArg >= 0 && process.argv[outputArg + 1]) fs.writeFileSync(process.argv[outputArg + 1], JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(evidence.passed ? 0 : 1);
}
}
void app.whenReady().then(probe);
