import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildWrapperDocument, ADAPTER_VERSION, SECURITY_POLICY_VERSION } from './frame-content.mjs';
import { GENERATED_WEB_PREFERENCES, WRAPPER_HEADERS, bootstrapRequestAllowed, checkedBounds, collectOwnership, recheckOwnedProcess, runtimeCapability } from './policy.mjs';
import { MessageBudget, readRunRequest, readRuntimeMessage, revisionDigest } from './protocol.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const lifetime = { count: 0 };
const MAX_RUNS = 32;
const GEOMETRY_LEASE_MS = 500;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const attempt = async operation => { try { return await operation(); } catch { return undefined; } };
const envelope = (state, type, extra = {}) => ({ protocolVersion: 1, runId: state.runId, revisionDigest: state.revisionDigest, type, ...extra });

/** Dependency injection is for a standalone main-process runtime harness only.
 * installGeneratedUI never supplies testPolicy and no IPC exposes it. */
export function createGeneratedUIManager({ electron, emit, audit = () => {}, testPolicy, clock = () => performance.now(), processKill = process.kill.bind(process), processExists = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
} }) {
  const { app, session, WebContentsView, webContents } = electron;
  const runs = new Map();
  const states = new Map();
  const admissions = new Map();
  const testEnabled = testPolicy?.testOnly === true && testPolicy?.enabled === true;
  const ledger = testEnabled ? (testPolicy.ledger ?? lifetime) : lifetime;
  let quarantined = false;
  const capability = () => quarantined
    ? { enabled: false, reason: 'Renderer cleanup could not be confirmed. Restart Deck before running another generated interface.' }
    : ledger.count >= MAX_RUNS
    ? { enabled: false, reason: 'The generated interface session limit was reached. Restart Deck to run another interface.' }
    : testEnabled ? { enabled: true, reason: 'Standalone test harness only; release gates remain unverified.' }
    : runtimeCapability({ adapterVersion: ADAPTER_VERSION, securityPolicyVersion: SECURITY_POLICY_VERSION });
  const allContents = () => webContents.getAllWebContents();
  const metrics = () => app.getAppMetrics();
  const ownerMatches = (state, owner) => state.win === owner.win && state.ownerFrame === owner.frame && !owner.win.isDestroyed() && owner.frame === owner.win.webContents.mainFrame;
  const foreground = win => !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused();
  const notify = (state, type, extra = {}) => {
    if (!state.win.isDestroyed() && state.ownerFrame === state.win.webContents.mainFrame) emit(state.win, { runId: state.runId, type, ...extra });
  };
  const detach = state => {
    if (state.attached && !state.win.isDestroyed()) { try { state.win.contentView.removeChildView(state.view); } catch {} }
    state.attached = false;
    try { state.view.setVisible(false); } catch {}
  };
  const bind = (state, target, event, listener) => {
    target.on(event, listener);
    state.listeners.push(() => target.removeListener(event, listener));
  };
  const ownership = state => collectOwnership(state.page, allContents(), metrics());
  const checkEstablished = state => {
    const now = ownership(state);
    if (!now.ok || now.records.length !== state.records.length || now.frames.some(frame => !state.frames.some(old => old.node === frame.node && old.pid === frame.pid && old.url === frame.url))) return false;
    return now.records.every(record => state.records.some(old => old.pid === record.pid && old.creationTime === record.creationTime));
  };
  const stillRunning = record => {
    const metric = metrics().find(metric => metric.pid === record.pid);
    // A known new birth means the recorded process exited and its PID was
    // reused. Missing Electron metrics alone are not OS-exit confirmation.
    return metric ? metric.creationTime === record.creationTime : processExists(record.pid);
  };

  async function stopState(state, reason = 'Stopped.') {
    if (state.stopping) return state.stopping;
    // Invalidate first. PID/frame records survive until cleanup completes.
    state.live = false;
    state.admission.live = false;
    if (admissions.get(state.win.id) === state.admission) admissions.delete(state.win.id);
    runs.delete(state.runId);
    if (states.get(state.win.id) === state) states.delete(state.win.id);
    detach(state);
    // Removing the native view leaves no focused contents; return keyboard focus to Deck.
    try { if (!state.win.isDestroyed() && state.win.isFocused()) state.win.webContents.focus(); } catch {}
    for (const timer of state.timers) { clearTimeout(timer); clearInterval(timer); }
    state.listeners.splice(0).forEach(remove => { try { remove(); } catch {} });
    state.document = null;
    state.rejectBootstrap?.(new Error(reason));
    state.stopping = (async () => {
      const hostPid = (() => { try { return state.page.getOSProcessId(); } catch { return 0; } })();
      const killRecords = [...state.records].sort((a, b) => Number(a.pid === hostPid) - Number(b.pid === hostPid));
      for (const record of killRecords) {
        // Inspect every other WebContents and process creation time immediately
        // before each destructive operation. Never kill a shared or stale PID.
        if (!recheckOwnedProcess(record, state.page, allContents(), metrics())) continue;
        if (record.pid === hostPid) await attempt(() => state.page.forcefullyCrashRenderer());
        else await attempt(() => processKill(record.pid, 'SIGKILL'));
      }
      await attempt(() => state.page.close({ waitForBeforeUnload: false }));
      await attempt(() => state.session.protocol.unhandle('https'));
      await Promise.allSettled([state.session.clearStorageData(), state.session.clearCache(), state.session.closeAllConnections()]);
      const deadline = clock() + 1500;
      while (state.records.some(stillRunning) && clock() < deadline) await wait(25);
      const remaining = state.records.filter(stillRunning).map(record => record.pid);
      if (remaining.length) quarantined = true;
      // Retain deny handlers if an old process could still exist; removing
      // them must never loosen a live or unconfirmed frame's authority.
      if (!remaining.length) {
        state.session.webRequest.onBeforeRequest(null);
        state.session.setPermissionRequestHandler(null);
        state.session.setPermissionCheckHandler(null);
        state.session.setDevicePermissionHandler(null);
        state.session.setDisplayMediaRequestHandler(null);
      }
      audit({ type: 'disposed', runId: state.runId, records: state.records, remaining, reason });
      notify(state, 'stopped', { reason: remaining.length ? `${reason} Renderer cleanup could not be confirmed; execution remains disabled.` : reason });
      if (remaining.length) console.error(`generated-ui cleanup: unconfirmed renderer PIDs ${remaining.join(',')}`);
      return { pids: state.records.map(record => record.pid), remaining };
    })();
    return state.stopping;
  }

  function configureSession(state) {
    const ses = state.session;
    if (ses.getPreloadScripts().length) throw new Error('Generated sessions must not have session preload scripts.');
    ses.enableNetworkEmulation({ offline: true });
    ses.protocol.handle('https', request => {
      if (!state.live || !state.document || request.url !== state.url || state.phase !== 'bootstrap') return new Response(null, { status: 403 });
      return new Response(state.document, { status: 200, headers: WRAPPER_HEADERS });
    });
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, done) => {
      const bootstrap = bootstrapRequestAllowed(details, state.url, state.live && state.phase === 'bootstrap');
      const localImage = state.live && details.resourceType === 'image' && /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);/i.test(details.url);
      const initialChild = state.live && state.phase === 'bootstrap' && details.url === 'about:srcdoc' && details.resourceType === 'subFrame';
      done({ cancel: !(bootstrap || localImage || initialChild) });
    });
    ses.setPermissionRequestHandler((_contents, _permission, done) => done(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.setDisplayMediaRequestHandler((_request, done) => done({}));
    bind(state, ses, 'will-download', (event, item) => { event.preventDefault(); item.cancel(); });
    bind(state, ses, 'file-system-access-restricted', (event, _details, done) => { event.preventDefault(); done('deny'); });
    for (const event of ['select-hid-device', 'select-usb-device']) bind(state, ses, event, (event, _details, done) => { event.preventDefault(); done(''); });
  }

  async function configureFileChooser(state) {
    // A separate control: permission handlers do not intercept <input type=file>.
    // The exact packaged interception/OOPIF behavior remains a release gate.
    const debug = state.page.debugger;
    debug.attach('1.3');
    bind(state, debug, 'detach', () => { if (state.live) void stopState(state, 'File chooser protection was lost.'); });
    bind(state, debug, 'message', (_event, method, params, sessionId) => {
      if (!state.live) return;
      if (method === 'Page.fileChooserOpened') { void stopState(state, 'File selection is unavailable in generated interfaces.'); return; }
      if (method === 'Target.attachedToTarget') {
        const id = params.sessionId;
        audit({ type: 'file-guard-target', runId: state.runId, targetType: params.targetInfo?.type });
        const protection = (async () => {
          // Resume only fixed bootstrap bytes. Some OOPIF Page-domain commands
          // wait until the target has begun initialization. The init barrier
          // below waits for every guard before delivering any model payload.
          await debug.sendCommand('Runtime.runIfWaitingForDebugger', {}, id);
          if (['iframe', 'page'].includes(params.targetInfo?.type)) {
            await debug.sendCommand('Page.enable', {}, id);
            await debug.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }, id);
            await debug.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, id);
          }
          audit({ type: 'file-guard-target-ready', runId: state.runId, targetType: params.targetInfo?.type });
        })().catch(error => { state.guardFailed = true; if (state.live) void stopState(state, `File chooser protection failed: ${error.message}`); });
        state.fileGuards.push(protection);
      }
      // Ignore every other CDP message; never forward CDP to model/UI.
      void sessionId;
    });
    await debug.sendCommand('Page.enable');
    await debug.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
    await debug.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    audit({ type: 'file-guard-ready', runId: state.runId });
  }

  function configureContents(state) {
    const page = state.page;
    bind(state, page, 'console-message', details => audit({ type: 'renderer-console', runId: state.runId, message: String(details.message).slice(0, 500) }));
    const deny = event => { event.preventDefault(); if (state.live) void stopState(state, 'Generated navigation was blocked.'); };
    bind(state, page, 'will-navigate', deny);
    bind(state, page, 'will-redirect', deny);
    bind(state, page, 'will-frame-navigate', event => {
      // Electron does not fire these for main-owned loadURL. Only the one
      // initial child srcdoc is admitted; data/about navigation is otherwise denied.
      if (state.phase === 'bootstrap' && !state.initialChildNavigation && !event.isMainFrame && event.url === 'about:srcdoc') { state.initialChildNavigation = true; return; }
      deny(event);
    });
    bind(state, page, 'did-start-navigation', (details, url, sameDocument, mainFrame) => {
      const target = details.url ?? url;
      const main = details.isMainFrame ?? mainFrame;
      if (state.phase === 'bootstrap' && !state.bootstrapLoadStarted && main && (target === 'about:blank' || target === '')) return;
      // Parsing the trusted wrapper creates its one empty iframe before its
      // fixed srcdoc assignment. Admit exactly that initial child blank once;
      // ownership verification still requires final tree = wrapper + srcdoc.
      if (state.phase === 'bootstrap' && !main && target === 'about:blank' && !state.initialChildBlank) { state.initialChildBlank = true; return; }
      if (state.phase === 'bootstrap' && ((main && target === state.url) || (!main && target === 'about:srcdoc'))) return;
      audit({ type: 'unexpected-navigation', runId: state.runId, phase: state.phase, url: String(target).slice(0, 200), main });
      if (state.live) void stopState(state, 'The generated frame changed document.');
      void sameDocument;
    });
    bind(state, page, 'frame-created', () => { if (state.phase !== 'bootstrap' && state.live) void stopState(state, 'Unexpected generated frame.'); });
    bind(state, page, 'did-frame-navigate', () => { if (state.phase !== 'bootstrap' && state.live && !checkEstablished(state)) void stopState(state, 'Generated process ownership changed.'); });
    bind(state, page, 'render-process-gone', () => { if (state.live) void stopState(state, 'Generated renderer stopped.'); });
    bind(state, page, 'destroyed', () => { if (state.live) void stopState(state, 'Generated view closed.'); });
    bind(state, page, 'will-attach-webview', event => { event.preventDefault(); void stopState(state, 'Nested browser views are unavailable.'); });
    bind(state, page, 'select-bluetooth-device', (event, _devices, done) => { event.preventDefault(); done(''); });
    bind(state, page, 'will-prevent-unload', event => event.preventDefault());
    page.setWindowOpenHandler(() => ({ action: 'deny' }));
    bind(state, state.win, 'resize', () => detach(state));
    bind(state, state.win, 'hide', () => { void stopState(state, 'Deck window hidden.'); });
    bind(state, state.win, 'minimize', () => { void stopState(state, 'Deck window minimized.'); });
    bind(state, state.win, 'blur', () => { void stopState(state, 'Deck window lost focus.'); });
    bind(state, state.win, 'closed', () => { void stopState(state, 'Deck window closed.'); });
    bind(state, state.win.webContents, 'did-start-navigation', () => { void stopState(state, 'Deck window changed document.'); });
    bind(state, state.win.webContents, 'render-process-gone', () => { void stopState(state, 'Deck renderer stopped.'); });
    bind(state, state.win.webContents, 'zoom-changed', () => { void stopState(state, 'Deck zoom changed.'); });
  }

  async function initialize(state) {
    if (!state.live || state.phase !== 'bootstrap') return;
    state.phase = 'checking';
    await state.fileProtection;
    await Promise.all(state.fileGuards);
    if (!state.live || state.guardFailed || !state.admission.live || admissions.get(state.win.id) !== state.admission) return;
    if (!ownerMatches(state, state.admission.owner) || !foreground(state.win)) { await stopState(state, 'The owning Deck frame is no longer in the foreground.'); return; }
    const owned = ownership(state);
    if (!owned.ok || owned.frames[0].url !== state.url) { await stopState(state, owned.reason ?? 'Unexpected generated document.'); return; }
    state.records = owned.records; state.frames = owned.frames;
    if (!checkEstablished(state)) { await stopState(state, 'Generated process ownership changed before initialization.'); return; }
    if (!state.attached) { await stopState(state, 'Interface geometry changed during initialization.'); return; }
    audit({ type: 'ownership-verified', runId: state.runId, records: state.records, frames: state.frames });
    state.phase = 'initializing';
    if (!state.live || !state.admission.live || admissions.get(state.win.id) !== state.admission) return;
    state.page.mainFrame.send('generated-ui:command', envelope(state, 'init', { card: state.card }));
    audit({ type: 'payload-delivered', runId: state.runId });
    state.geometryAt = clock();
    state.resolveBootstrap({ runId: state.runId, revisionDigest: state.revisionDigest });
  }

  function receive(event, value) {
    const state = [...states.values()].find(candidate => candidate.page === event.sender);
    if (!state?.live || event.senderFrame !== state.page.mainFrame || event.senderFrame.url !== state.url) return;
    const limit = state.budget.accept(value?.type, clock());
    if (limit === 'stop') { void stopState(state, 'The interface sent too many messages.'); return; }
    if (limit === 'drop') return;
    const read = readRuntimeMessage(value, state, event.ports ?? []);
    if (!read.ok) return;
    if (value.type === 'bootstrap') audit({ type: 'bootstrap-received', runId: state.runId });
    const message = read.message;
    if (message.type === 'fault') { void stopState(state, 'The interface sent too many messages.'); return; }
    if (message.type === 'bootstrap') { if (state.phase === 'bootstrap') void initialize(state).catch(error => stopState(state, error.message)); return; }
    if (!state.records.length || !checkEstablished(state)) { void stopState(state, 'Generated process ownership changed.'); return; }
    if (message.type === 'ready') {
      if (state.phase !== 'initializing') return;
      state.phase = 'ready'; state.lastPong = clock(); notify(state, 'ready'); return;
    }
    if (state.phase !== 'ready') return;
    if (message.type === 'pong') {
      if (message.nonce === state.nonce) { state.nonce = null; state.lastPong = clock(); }
    } else if (message.type === 'resize') notify(state, 'resize', { height: message.height });
    else if (message.type === 'discuss') notify(state, 'discuss', { text: message.text });
  }

  async function run(owner, request) {
    if (!capability().enabled) throw new Error(capability().reason);
    const read = readRunRequest(request);
    if (!read.ok) throw new Error(read.reason);
    if (owner.win.isDestroyed() || owner.frame !== owner.win.webContents.mainFrame) throw new Error('Not the Deck window.');
    if (!foreground(owner.win)) throw new Error('The Deck window must be in the foreground.');
    const zoom = owner.win.webContents.getZoomFactor();
    const bounds = checkedBounds(read.bounds, owner.win.getContentBounds(), zoom);
    if (!bounds) throw new Error('The interface must be visible inside the Deck window.');
    // Register admission synchronously, before disposal/setup can yield. The
    // owner can cancel by requestId while no runId has been returned yet.
    const admission = { owner, requestId: read.requestId, live: true, state: null };
    const olderAdmission = admissions.get(owner.win.id);
    if (olderAdmission) olderAdmission.live = false;
    admissions.set(owner.win.id, admission);
    const previous = states.get(owner.win.id);
    if (previous) await stopState(previous, 'Replaced by a fresh approved interface.');
    if (!admission.live || admissions.get(owner.win.id) !== admission) throw new Error('Generated interface approval was cancelled.');
    if (!foreground(owner.win) || owner.frame !== owner.win.webContents.mainFrame) {
      admission.live = false; admissions.delete(owner.win.id);
      throw new Error('The owning Deck frame is no longer in the foreground.');
    }
    if (!capability().enabled) throw new Error(capability().reason);
    const runId = randomBytes(16).toString('hex');
    const digest = revisionDigest(read.card, read.identity, { adapter: ADAPTER_VERSION, security: SECURITY_POLICY_VERSION });
    const ses = session.fromPartition(`generated-${runId}`, { cache: false });
    ledger.count++;
    const view = new WebContentsView({ webPreferences: { ...GENERATED_WEB_PREFERENCES, session: ses, preload: path.join(here, 'preload.cjs') } });
    const state = { runId, revisionDigest: digest, win: owner.win, ownerFrame: owner.frame, card: read.card, identity: read.identity,
      session: ses, view, page: view.webContents, live: true, phase: 'bootstrap', attached: false,
      timers: [], listeners: [], records: [], frames: [], fileGuards: [], budget: new MessageBudget(),
      admission, zoom, nonce: null, lastPong: clock(), started: clock(), geometryAt: null, url: `https://generated-ui.invalid/${runId}` };
    admission.state = state;
    state.document = buildWrapperDocument({ runId, revisionDigest: digest });
    const promise = new Promise((resolve, reject) => { state.resolveBootstrap = resolve; state.rejectBootstrap = reject; });
    void promise.catch(() => {}); // Setup can fail before run reaches its await.
    states.set(owner.win.id, state); runs.set(runId, state);
    try {
      configureSession(state); configureContents(state);
      state.timers.push(setInterval(() => {
        if (!state.live) return;
        const now = clock();
        if (state.win.webContents.getZoomFactor() !== state.zoom) { void stopState(state, 'Deck zoom changed.'); return; }
        if (state.geometryAt !== null && now - state.geometryAt > GEOMETRY_LEASE_MS) { void stopState(state, 'Interface geometry expired.'); return; }
        if (state.phase !== 'ready' && now - state.started >= 2000) { void stopState(state, 'The interface did not become ready within two seconds.'); return; }
        if (state.phase === 'ready' && now - state.lastPong >= 5000) { void stopState(state, 'The interface stopped responding.'); return; }
        if (state.records.length && !checkEstablished(state)) void stopState(state, 'Generated process ownership changed.');
      }, 100));
      state.timers.push(setInterval(() => {
        if (!state.live || state.phase !== 'ready') return;
        state.nonce = randomBytes(16).toString('hex');
        state.page.mainFrame.send('generated-ui:command', envelope(state, 'ping', { nonce: state.nonce }));
      }, 1000));
      // CDP Page commands need a live renderer. Start them before loading the
      // trusted bootstrap, but await completion only after the load begins.
      // initialize independently awaits this barrier before supplying model bytes.
      state.fileProtection = configureFileChooser(state);
      void state.fileProtection.catch(error => { if (state.live) void stopState(state, `File chooser protection failed: ${error.message}`); });
      if (!state.live || !admission.live || admissions.get(owner.win.id) !== admission) return await promise;
      view.setBounds(bounds); view.setVisible(true); owner.win.contentView.addChildView(view); state.attached = true;
      state.bootstrapLoadStarted = true;
      void state.page.loadURL(state.url).catch(error => { if (state.live) void stopState(state, `Generated bootstrap failed: ${error.message}`); });
      await state.fileProtection;
      return await promise;
    } catch (error) { await stopState(state, error.message); throw error; }
  }

  function bounds(owner, runId, value) {
    const state = runs.get(runId);
    if (!state || !ownerMatches(state, owner)) return;
    if (value === null) { void stopState(state, 'Interface is no longer visible.'); return; }
    const zoom = owner.win.webContents.getZoomFactor();
    if (zoom !== state.zoom) { void stopState(state, 'Deck zoom changed.'); return; }
    const checked = checkedBounds(value, owner.win.getContentBounds(), zoom);
    if (!checked) { detach(state); void stopState(state, 'Interface bounds are outside the visible card.'); return; }
    state.geometryAt = clock(); state.view.setBounds(checked); state.view.setVisible(true);
    if (!state.attached) { owner.win.contentView.addChildView(state.view); state.attached = true; }
  }
  async function stop(owner, runId) {
    const state = runs.get(runId);
    if (state && ownerMatches(state, owner)) await stopState(state);
  }
  async function cancel(owner, requestId) {
    const admission = admissions.get(owner.win.id);
    if (!admission || admission.requestId !== requestId || admission.owner.frame !== owner.frame || admission.owner.win !== owner.win) return;
    admission.live = false;
    admissions.delete(owner.win.id);
    if (admission.state) await stopState(admission.state, 'Generated interface approval was cancelled.');
  }
  async function stopAll(reason) { await Promise.all([...states.values()].map(state => stopState(state, reason))); }
  return { capability, run, bounds, stop, cancel, stopAll, receive };
}

export function installGeneratedUI({ electron, deckWindow }) {
  const { ipcMain, app, powerMonitor } = electron;
  const manager = createGeneratedUIManager({ electron, emit: (win, event) => { if (!win.webContents.isDestroyed()) win.webContents.send('generated-ui:event', event); } });
  const owner = event => {
    const entry = deckWindow(event);
    if (!entry || event.sender !== entry.win.webContents || event.senderFrame !== entry.win.webContents.mainFrame) throw new Error('Not the Deck window.');
    return { win: entry.win, frame: event.senderFrame };
  };
  ipcMain.handle('generated-ui:capability', event => { owner(event); return manager.capability(); });
  ipcMain.handle('generated-ui:run', (event, request) => manager.run(owner(event), request));
  ipcMain.handle('generated-ui:stop', (event, runId) => manager.stop(owner(event), runId));
  ipcMain.handle('generated-ui:cancel', (event, requestId) => manager.cancel(owner(event), requestId));
  ipcMain.on('generated-ui:bounds', (event, runId, bounds) => { try { manager.bounds(owner(event), runId, bounds); } catch {} });
  ipcMain.on('generated-ui:message', (event, value) => manager.receive(event, value));
  app.whenReady().then(() => {
    for (const event of ['suspend', 'shutdown']) powerMonitor.on(event, () => { void manager.stopAll(`System ${event}.`); });
  });
  app.on('before-quit', () => { void manager.stopAll('Deck is quitting.'); });
  return manager;
}
