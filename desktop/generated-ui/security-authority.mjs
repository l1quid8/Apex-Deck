// Actual packaged production Deck authority gates with an isolated real daemon.
// Attack fixtures use a test-only manager; production capability is checked separately.
import { app, BrowserWindow, ipcMain, session, WebContentsView, webContents, shell, dialog } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const arg = process.argv.indexOf('--authority-evidence-dir');
if (arg < 0 || !process.argv[arg + 1]) throw new Error('An isolated evidence directory is required.');
const root = path.resolve(process.argv[arg + 1]);
const data = path.join(root, 'isolated-host');
if (process.env.APEX_DECK_DATA_DIR !== data) throw new Error('Refusing a nonisolated Deck data folder.');
const archive = process.env.APEX_AUTHORITY_PRODUCTION_ARCHIVE;
if (!archive || !archive.startsWith(root + path.sep)) throw new Error('Refusing an unscoped production archive.');
const production = file => pathToFileURL(path.join(archive, file)).href;
const focused = process.env.APEX_AUTHORITY_FOCUSED === '1';
const evidence = {
  startedAt: new Date().toISOString(), packaged: app.isPackaged,
  versions: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
  actualProductionMain: true, actualProductionRenderer: true, actualProductionPreload: true,
  actualProductionIPC: true, actualProductionCustomProtocol: true, realIsolatedDaemon: true,
  productionRunEnabled: null, testOnlyAdmission: true,
  focusedPermissionDiagnostic: focused,
  instrumentation: ['Observe IPC registrations without modifying handler logic', 'Intercept shell.openExternal/openPath to count unexpected forwarding without launching another application', 'Intercept main-process dialog APIs to count unexpected prompts without opening them', 'Direct unauthorized handler calls are defense-in-depth diagnostic, not an available generated-frame IPC bridge', 'CDP input injection provides test-only gestures and isolated file drops'],
  pending: ['Independent complete security review', 'Network and native UX release gates remain separate'],
  probes: [], observations: [], ipcReceipts: [], externalCalls: [], dialogCalls: [], events: [], failures: [],
};
const handles = new Map(), listeners = new Map();
const originalHandle = ipcMain.handle.bind(ipcMain), originalOn = ipcMain.on.bind(ipcMain);
ipcMain.handle = (channel, handler) => {
  handles.set(channel, handler);
  return originalHandle(channel, (event, ...args) => { evidence.ipcReceipts.push({ channel, sender: event.sender.id, frame: event.senderFrame?.url, kind: 'invoke' }); return handler(event, ...args); });
};
ipcMain.on = (channel, handler) => {
  if (!listeners.has(channel)) listeners.set(channel, []);
  listeners.get(channel).push(handler);
  return originalOn(channel, (event, ...args) => { evidence.ipcReceipts.push({ channel, sender: event.sender?.id, frame: event.senderFrame?.url, kind: 'send' }); return handler(event, ...args); });
};
for (const name of ['openExternal', 'openPath']) shell[name] = async (...args) => { evidence.externalCalls.push({ name, args }); return name === 'openPath' ? '' : undefined; };
for (const name of ['showOpenDialog', 'showSaveDialog', 'showMessageBox']) dialog[name] = async () => { evidence.dialogCalls.push({ name }); return { canceled: true, response: 1, filePaths: [] }; };
dialog.showMessageBoxSync = () => { evidence.dialogCalls.push({ name: 'showMessageBoxSync' }); return 1; };
fs.mkdirSync(path.join(root, 'downloads'), { recursive: true });
app.setPath('downloads', path.join(root, 'downloads'));
await import(production('desktop/main.mjs'));
const { createGeneratedUIManager } = await import(production('desktop/generated-ui/host.mjs'));
const { WRAPPER_HEADERS } = await import(production('desktop/generated-ui/policy.mjs'));
const { runtimeCapability } = await import(production('desktop/generated-ui/policy.mjs'));
const { ADAPTER_VERSION, SECURITY_POLICY_VERSION } = await import(production('desktop/generated-ui/frame-content.mjs'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, ms = 12_000) { const end = Date.now() + ms; while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(25); } throw new Error('Authority probe timed out.'); }
let win, owner, manager, renewing, current, daemon, nativeClipboard;
const bounds = { x: 20, y: 80, width: 700, height: 300 };
const eventFor = (run, type) => evidence.events.find(event => event.runId === run.runId && event.type === type);
const receive = (event, value) => manager?.receive(event, value);
const fileCanary = path.join(data, 'file-canary.txt');
async function startPasteboardHelper() {
  const binary = process.env.APEX_AUTHORITY_PASTEBOARD_HELPER;
  if (!binary || !binary.startsWith(root + path.sep)) throw new Error('Scoped native pasteboard helper required.');
  const child = spawn(binary, [], { stdio: ['pipe','pipe','pipe'] });
  const responses = new Map(); let buffer = '', next = 0, ready = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => {}); // No native data, errors or type bytes enter evidence.
  child.stdout.on('data', bytes => { buffer += bytes; let at; while ((at = buffer.indexOf('\n')) >= 0) { const row = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); if (row.ready) ready = true; else { const request = responses.get(row.id); if (request) { responses.delete(row.id); clearTimeout(request.timer); request.resolve(row); } } } });
  child.stdin.on('error', () => {});
  const call = (command, args = {}) => new Promise((resolve,reject) => { const id = next++; const timer = setTimeout(() => { responses.delete(id); reject(new Error('Pasteboard helper timed out.')); }, 5000); responses.set(id, { resolve, timer }); child.stdin.write(JSON.stringify({ id, command, ...args }) + '\n'); });
  await until(() => ready, 5000);
  return { call, child, async close() { const receipt = await call('finish'); child.stdin.end(); await until(() => child.exitCode !== null, 5000); return receipt; } };
}
async function focusChild(page, child, id) {
  page.focus(); await child.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).focus();`, true);
  await until(() => child.executeJavaScript('document.hasFocus()'));
  return child.executeJavaScript('({focused:document.hasFocus(),activation:navigator.userActivation.isActive,secure:isSecureContext})', true);
}
async function nativePaste(page) {
  // Electron sendInputEvent does not route keys into an OOPIF. Use the actual
  // OS paste shortcut, with both focus and front-process checks before delivery.
  assert.equal(win.isFocused(), true);
  const child = page.mainFrame.framesInSubtree.find(frame => frame.url === 'about:srcdoc');
  assert.equal(await child.executeJavaScript('document.hasFocus()'), true);
  const pressed = execFileSync('osascript', ['-e','tell application "System Events"','-e',`if (unix id of (first process whose frontmost is true)) is ${process.pid} then`,'-e','key code 9 using command down','-e','return "sent"','-e','end if','-e','return "skipped"','-e','end tell']).toString().trim();
  assert.equal(pressed, 'sent');
  await sleep(100);
}
async function nativePositiveControl(canary) {
  const partition = `native-positive-${crypto.randomUUID()}`, ses = session.fromPartition(partition, { cache: false });
  const url = `https://native-control.invalid/${crypto.randomUUID()}`;
  const childScript = `window.nativeReceipt={pasteTrusted:false,pasteCanary:false,dropTrusted:false,dropCanary:false};addEventListener('paste',e=>{nativeReceipt.pasteTrusted=e.isTrusted;nativeReceipt.pasteCanary=e.clipboardData?.getData('text/plain')===${JSON.stringify(canary)}});for(const t of ['dragenter','dragover'])addEventListener(t,e=>e.preventDefault());addEventListener('drop',e=>{e.preventDefault();nativeReceipt.dropTrusted=e.isTrusted;const f=e.dataTransfer?.files[0];if(f)f.text().then(t=>nativeReceipt.dropCanary=t==='FILE_CANARY_DO_NOT_READ_OR_CHANGE')});`;
  const srcdoc = `<!doctype html><html><body><textarea id="native-input"></textarea><div id="drop-target" style="height:150px;width:600px">Drop control</div><script>${childScript}</script></body></html>`;
  const document = `<!doctype html><html><body style="margin:0"><iframe id="child" sandbox="allow-scripts" style="height:300px;width:700px;border:0"></iframe><script>document.getElementById('child').srcdoc=${JSON.stringify(srcdoc).replace(/</g,'\\u003c')};</script></body></html>`;
  ses.enableNetworkEmulation({ offline: true });
  ses.protocol.handle('https', request => request.url === url ? new Response(document, { headers: WRAPPER_HEADERS }) : new Response(null,{status:403}));
  const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  const page = view.webContents;
  view.setBounds(bounds); win.contentView.addChildView(view);
  try {
    await page.loadURL(url); const child = await until(() => page.mainFrame.framesInSubtree.find(frame => frame.url === 'about:srcdoc'));
    await until(() => child.executeJavaScript('!!window.nativeReceipt'));
    page.debugger.attach('1.3'); await page.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const focus = await focusChild(page, child, 'native-input'); await nativePaste(page);
    const paste = await child.executeJavaScript('({trusted:window.nativeReceipt.pasteTrusted,canaryMatches:window.nativeReceipt.pasteCanary})');
    assert.equal(paste.trusted, true, 'Meta-V must cause browser-native trusted paste'); assert.equal(paste.canaryMatches, true, 'Native paste positive control must receive temporary clipboard canary');
    const dropRoute = await nativeDropFile(page, 80, 70);
    await until(() => child.executeJavaScript('window.nativeReceipt.dropCanary'), 3000);
    const drop = await child.executeJavaScript('({trusted:window.nativeReceipt.dropTrusted,canaryMatches:window.nativeReceipt.dropCanary})');
    assert.equal(drop.trusted, true); assert.equal(drop.canaryMatches, true);
    return { syntheticUnguardedFixture: true, sameOpaqueSandbox: true, exactProductionPermissionHeaders: true, focus, nativePaste: paste, nativeDrop: drop, dropRoute };
  } finally {
    win.contentView.removeChildView(view); page.close({waitForBeforeUnload:false});
    await ses.protocol.unhandle('https'); await ses.clearStorageData();
  }
}
async function nativeDropFile(page, x, y, items = []) {
  const data = { items, files: [fileCanary], dragOperationsMask: 1 };
  for (const type of ['dragEnter','dragOver','drop']) await page.debugger.sendCommand('Input.dispatchDragEvent', { type, x, y, data });
  const targets = await page.debugger.sendCommand('Target.getTargets');
  const target = targets.targetInfos.find(info => info.type === 'iframe' && info.url === 'about:srcdoc');
  if (!target) return { rootTarget: true, childTarget: false };
  const { sessionId } = await page.debugger.sendCommand('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  try {
    for (const type of ['dragEnter','dragOver','drop']) await page.debugger.sendCommand('Input.dispatchDragEvent', { type, x, y, data }, sessionId);
    return { rootTarget: true, childTarget: true, childTargetType: target.type };
  } finally { await page.debugger.sendCommand('Target.detachFromTarget', { sessionId }); }
}
async function connectDaemon() {
  const socket = net.createConnection(path.join(data, 'daemon.sock'));
  socket.setEncoding('utf8');
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  let text = '', next = 0; const calls = new Map();
  socket.on('data', chunk => { text += chunk; let at; while ((at = text.indexOf('\n')) >= 0) { const line = text.slice(0, at); text = text.slice(at + 1); if (!line) continue; const value = JSON.parse(line); if (!calls.has(value.id)) continue; const { resolve, reject, timer } = calls.get(value.id); calls.delete(value.id); clearTimeout(timer); value.err ? reject(new Error(value.err)) : resolve(value.ok); } });
  const call = (cmd, args = {}) => new Promise((resolve, reject) => { const id = next++; const timer = setTimeout(() => reject(new Error(`Daemon timed out: ${cmd}`)), 6000); calls.set(id, { resolve, reject, timer }); socket.write(JSON.stringify({ id, cmd, args }) + '\n'); });
  const welcome = await call('hello', { protocol: 1 });
  return { socket, call, welcome, close: () => socket.destroy() };
}
async function snapshot() {
  const page = await win.webContents.executeJavaScript(`(async()=>({canary:window.DECK_AUTHORITY_CANARY,dom:document.getElementById('authority-canary').textContent,local:localStorage.getItem('authority-secret'),session:sessionStorage.getItem('authority-secret'),drafts:[...document.querySelectorAll('textarea')].map(n=>({label:n.getAttribute('aria-label'),value:n.value})),db:await new Promise((resolve,reject)=>{const r=indexedDB.open('authority-canary-db',1);r.onsuccess=()=>{const tx=r.result.transaction('secrets');const q=tx.objectStore('secrets').get('deck-secret');q.onsuccess=()=>{resolve(q.result);r.result.close()};q.onerror=()=>reject(q.error)}})}))()`);
  return { page, room: await daemon.call('room_state', { id: 'authority-thread' }), file: fs.readFileSync(fileCanary, 'utf8'), cookie: await win.webContents.session.cookies.get({ name: 'authority-cookie' }), profile: app.getPath('userData') };
}
let baseline, chatPid, forbiddenStart;
async function checkCanaries() {
  assert.equal(win.webContents.getOSProcessId(), chatPid, 'Deck renderer must keep its PID');
  assert.deepEqual(await snapshot(), baseline, 'Deck data/drafts/daemon transcript/file/cookies must remain unchanged');
  assert.equal(evidence.externalCalls.length, forbiddenStart.external, 'Generated frames must never forward external links');
  assert.equal(evidence.dialogCalls.length, forbiddenStart.dialogs, 'Generated frames must never open native dialogs');
  assert.deepEqual(fs.readdirSync(path.join(root, 'downloads')), [], 'No generated download/export may be delivered');
}
async function run(id, js = '', html = '<button id="probe-button">Probe</button><output id="result"></output>') {
  const card = { schemaVersion: 1, kind: 'generated', cardId: id, title: id, summary: 'Authority gate fixture', html, css: '', js, fallback: 'Authority fixture fallback.' };
  current = await manager.run(owner, { requestId: `${id}-request-0000000000001`, source: JSON.stringify(card), identity: { threadId: 'authority-thread', seq: 1, cardId: id, hostId: 'local' }, bounds });
  await until(() => eventFor(current, 'ready'));
  const page = webContents.getAllWebContents().find(page => page.getURL().endsWith(current.runId));
  const child = page.mainFrame.framesInSubtree.find(frame => frame.url === 'about:srcdoc');
  return { ...current, page, child };
}
async function stop(run) {
  await manager.stop(owner, run.runId); await until(() => eventFor(run, 'stopped'));
  assert.deepEqual(evidence.observations.find(row => row.type === 'disposed' && row.runId === run.runId).remaining, [], 'All generated PIDs exited'); current = null; await checkCanaries();
}
async function group(name, fn) { const start = Date.now(); console.log(`authority: ${name}`); let timer; try { const details = await Promise.race([fn(), new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Authority group exceeded 20 seconds.')),20_000)})]); evidence.probes.push({ name, passed: true, elapsedMs: Date.now() - start, ...details }); } catch (error) { evidence.probes.push({ name, passed: false, elapsedMs: Date.now() - start, error: error.stack || String(error) }); evidence.failures.push(name); if (current) { await manager.stop(owner, current.runId); current = null; } } finally { clearTimeout(timer); } }
async function childReport(run, code, userGesture = false) {
  await run.child.executeJavaScript(`(async()=>{const r={};const read=async(k,f)=>{try{r[k]={value:await f()}}catch(e){r[k]={error:e.name||e.constructor?.name||'Error',message:e.message,code:e.code}}};${code};window.__authorityReport=r;})()`, userGesture);
  const result = await until(() => run.child.executeJavaScript('window.__authorityReport||null'));
  evidence.observations.push({ type: 'child-authority-report', runId: run.runId, userGesture, result });
  return result;
}
async function probe() {
try {
  assert.equal(app.isPackaged, true);
  win = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('app://deck')));
  await until(() => win.webContents.executeJavaScript('document.querySelector("#root")?.children.length>0&&typeof apexDeck==="object"').catch(() => false));
  // Keep the real window off the user's workspace, before creating generated hosts.
  win.setOpacity(0); win.setIgnoreMouseEvents(true); win.showInactive();
  if (focused) { win.show(); app.focus({ steal: true }); win.focus(); await until(() => win.isFocused()); await sleep(250); }
  await until(() => fs.existsSync(path.join(data, 'daemon.sock')));
  daemon = await connectDaemon();
  evidence.daemon = { dataDir: data, socket: path.join(data, 'daemon.sock'), metadata: JSON.parse(fs.readFileSync(path.join(data, 'daemon.json'), 'utf8')), welcome: daemon.welcome };
  await daemon.call('room_create', { id: 'authority-thread', options: { policy: 'mention', max_bot_hops: 3 }, cwd: null, participants: [] });
  await daemon.call('room_post', { id: 'authority-thread', text: 'DAEMON_MESSAGE_CANARY_DO_NOT_READ_OR_CHANGE' });
  fs.writeFileSync(fileCanary, 'FILE_CANARY_DO_NOT_READ_OR_CHANGE');
  await win.webContents.executeJavaScript(`(async()=>{window.DECK_AUTHORITY_CANARY='WINDOW_CANARY';const n=document.createElement('p');n.id='authority-canary';n.textContent='DOM_CANARY';n.hidden=true;document.body.append(n);localStorage.setItem('authority-secret','LOCAL_CANARY');sessionStorage.setItem('authority-secret','SESSION_CANARY');await new Promise((resolve,reject)=>{const r=indexedDB.open('authority-canary-db',1);r.onupgradeneeded=()=>r.result.createObjectStore('secrets');r.onsuccess=()=>{const tx=r.result.transaction('secrets','readwrite');tx.objectStore('secrets').put('INDEXEDDB_CANARY','deck-secret');tx.oncomplete=()=>{r.result.close();resolve()};tx.onerror=()=>reject(tx.error)}});const draft=document.querySelector('textarea');if(draft){const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(draft,'DRAFT_CANARY_DO_NOT_CHANGE');draft.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  await win.webContents.session.cookies.set({ url: 'https://generated-ui.invalid', name: 'authority-cookie', value: 'COOKIE_CANARY', secure: true });
  await sleep(300); baseline = await snapshot(); chatPid = win.webContents.getOSProcessId(); owner = { win, frame: win.webContents.mainFrame };
  evidence.initialCanaries = baseline; evidence.chatPid = chatPid; evidence.rendererURL = win.webContents.getURL();
  forbiddenStart = { external: evidence.externalCalls.length, dialogs: evidence.dialogCalls.length };
  manager = createGeneratedUIManager({ electron: { app, session, WebContentsView, webContents }, testPolicy: { testOnly: true, enabled: true, ledger: { count: 0 } }, emit(_win, event) { evidence.events.push({ at: Date.now(), ...event }); if (focused && event.type === 'stopped') console.log(`authority stopped: ${event.reason}`); }, audit(event) { evidence.observations.push({ at: Date.now(), ...event }); } });
  // Install a second listener; the unmodified production manager remains installed.
  originalOn('generated-ui:message', receive);
  renewing = setInterval(() => { if (current) manager.bounds(owner, current.runId, bounds); }, 100);

  await group('real production capability matches its exact runtime registry; trusted preload and daemon positive control', async () => {
    const capability = await win.webContents.executeJavaScript('apexDeck.generatedUI.capability()');
    assert.deepEqual(capability, runtimeCapability({ adapterVersion: ADAPTER_VERSION, securityPolicyVersion: SECURITY_POLICY_VERSION }));
    evidence.productionRunEnabled = capability.enabled;
    const connection = await win.webContents.executeJavaScript('apexDeck.connection.current()'); assert.equal(connection.id, 'local');
    const row = await daemon.call('room_state', { id: 'authority-thread' }); assert.ok(JSON.stringify(row).includes('DAEMON_MESSAGE_CANARY'));
    return { capability, connection, productionHandlerCount: handles.size, productionEventChannels: [...listeners.keys()], renderer: baseline.page };
  });
  if (process.env.APEX_AUTHORITY_PASTEBOARD_HELPER) await group('native Cmd-V and file-drop positive controls; focused clipboard read/write and document replacement guards', async () => {
    nativeClipboard = await startPasteboardHelper();
    const canary = 'DECK_NATIVE_PASTE_' + crypto.randomBytes(24).toString('hex');
    const attackCanary = 'DECK_NATIVE_WRITE_' + crypto.randomBytes(24).toString('hex');
    const begin = await nativeClipboard.call('begin', { canary, attackCanary });
    assert.equal(begin.ok, true, 'Every original pasteboard item/type must be preservable before any change');
    assert.equal(begin.snapshotComplete, true); assert.equal(begin.canaryMatches, true);
    let guarded;
    try {
      const positive = await nativePositiveControl(canary);
      guarded = await run('native-clipboard', `window.documentAttempts=[];for(const target of [document,Document.prototype])for(const name of ['open','write','writeln']){try{Reflect.apply(target[name],document,name==='open'?[]:['<textarea id="native-input"></textarea><div style="height:150px">Drop</div>']);documentAttempts.push({blocked:false})}catch{documentAttempts.push({blocked:true})}}try{document.close()}catch{};window.nativeReceipt={pasteSeen:false,pasteCanary:false,dropSeen:false,dropCanary:false};for(const t of ['dragenter','dragover'])addEventListener(t,e=>e.preventDefault(),true);addEventListener('paste',e=>{nativeReceipt.pasteSeen=e.isTrusted;nativeReceipt.pasteCanary=e.clipboardData?.getData('text/plain')===${JSON.stringify(canary)}},true);addEventListener('drop',e=>{nativeReceipt.dropSeen=e.isTrusted;const f=e.dataTransfer?.files[0];if(f)f.text().then(t=>nativeReceipt.dropCanary=t==='FILE_CANARY_DO_NOT_READ_OR_CHANGE')},true);`, '<textarea id="native-input"></textarea><div style="height:150px">Drop</div>');
      const focus = await focusChild(guarded.page, guarded.child, 'native-input');
      const api = await guarded.child.executeJavaScript(`(async()=>{const r={readSucceeded:false,readCanary:false,writeSucceeded:false};try{const text=await navigator.clipboard.readText();r.readSucceeded=true;r.readCanary=text===${JSON.stringify(canary)}}catch(e){r.readError=e.name}try{await navigator.clipboard.writeText(${JSON.stringify(attackCanary)});r.writeSucceeded=true}catch(e){r.writeError=e.name}return r})()`, true);
      const clipboard = await nativeClipboard.call('check');
      evidence.observations.push({ type: 'native-clipboard-api-receipt', focus, api, clipboard });
      assert.equal(focus.focused, true); assert.equal(focus.activation, true);
      assert.equal(api.readSucceeded, false); assert.equal(api.writeSucceeded, false);
      assert.equal(clipboard.canaryMatches, true); assert.equal(clipboard.ownedChangeCount, true);
      const attempts = await guarded.child.executeJavaScript('window.documentAttempts'); assert.equal(attempts.length, 6); assert.ok(attempts.every(row => row.blocked));
      await nativePaste(guarded.page);
      const dropRoute = await nativeDropFile(guarded.page, 80, 70);
      await sleep(150);
      const receiver = await guarded.child.executeJavaScript('({pasteSeen:window.nativeReceipt.pasteSeen,pasteCanary:window.nativeReceipt.pasteCanary,dropSeen:window.nativeReceipt.dropSeen,dropCanary:window.nativeReceipt.dropCanary,inputEmpty:document.getElementById("native-input").value===""})');
      assert.deepEqual(receiver, { pasteSeen: false, pasteCanary: false, dropSeen: false, dropCanary: false, inputEmpty: true });
      await stop(guarded); guarded = null;
      return { originalSnapshotComplete: true, positive, focus, api, clipboard, documentMethodsBlocked: true, nativeReceiver: receiver, dropRoute };
    } finally {
      if (guarded) await stop(guarded);
      const restored = await nativeClipboard.close(); nativeClipboard = null;
      evidence.nativePasteboardCleanup = restored;
      assert.equal(restored.ok, true); assert.ok(restored.restoreMatched || restored.newerClipboardPreserved);
    }
  });
  await group('opaque generated child cannot read real Deck DOM, storage, IndexedDB, Node, preload or daemon APIs', async () => {
    const runResult = await run('real-data-isolation');
    const result = await childReport(runResult, `
      await read('parentDOM',()=>parent.document.body.textContent);await read('topDOM',()=>top.document.body.textContent);
      await read('parentCanary',()=>parent.DECK_AUTHORITY_CANARY);await read('parentBridge',()=>typeof parent.generatedUIHost);
      await read('topBridge',()=>typeof top.apexDeck);await read('local',()=>localStorage.getItem('authority-secret'));
      await read('session',()=>sessionStorage.getItem('authority-secret'));await read('cookie',()=>document.cookie);
      await read('indexedDB',()=>new Promise((res,rej)=>{let q;try{q=indexedDB.open('authority-canary-db')}catch(e){rej(e);return}q.onsuccess=()=>res('opened');q.onerror=()=>rej(q.error)}));
      for(const key of ['require','process','module','Buffer','apexDeck','generatedUIHost','ipcRenderer','electron'])await read(key,()=>typeof window[key]);
      await read('fileFetch',async()=>{const q=await fetch(${JSON.stringify(pathToFileURL(fileCanary).href)});return q.text()});
      await read('appFetch',async()=>{const q=await fetch('app://deck/');return q.text()});
      await read('nodeImport',()=>import('node:fs'));await read('electronImport',()=>import('electron'));
      await read('daemonWebSocket',()=>new WebSocket('ws://127.0.0.1:1/daemon'));`);
    for (const key of ['parentDOM','topDOM','parentCanary','parentBridge','topBridge','local','session','cookie','indexedDB']) assert.equal(result[key].error, 'SecurityError', key);
    for (const key of ['require','process','module','Buffer','apexDeck','generatedUIHost','ipcRenderer','electron']) assert.equal(result[key].value, 'undefined', key);
    for (const key of ['fileFetch','appFetch','nodeImport','electronImport']) assert.ok(result[key].error, key);
    await stop(runResult); return { results: result };
  });
  await group('every real Deck IPC invoke handler rejects generated main/child and mismatched owner frame', async () => {
    const runResult = await run('ipc-authority'); const results = [];
    const bad = [ { name: 'generated-wrapper', sender: runResult.page, senderFrame: runResult.page.mainFrame }, { name: 'generated-child', sender: runResult.page, senderFrame: runResult.child }, { name: 'Deck-sender-wrong-frame', sender: win.webContents, senderFrame: runResult.child } ];
    for (const actor of bad) for (const [channel, handler] of handles) {
      let rejected = false, error; try { await handler(actor, {}, null, null); } catch (cause) { error = cause.message; rejected = /Not the Deck window/.test(error); }
      results.push({ actor: actor.name, channel, rejected, error }); assert.equal(rejected, true, `${actor.name} ${channel}`);
    }
    for (const actor of bad) for (const channel of ['daemon:send','daemon:close','apex:smoke','apex:tauriStorage','browser:bounds','generated-ui:bounds']) {
      const event = { ...actor }; for (const handler of listeners.get(channel) || []) handler(event, 'local', 1, JSON.stringify({ id: 999, cmd: 'room_post', args: { id: 'authority-thread', text: 'ATTACK_MESSAGE' } }));
      results.push({ actor: actor.name, channel, returnValue: event.returnValue });
      if (channel === 'apex:smoke') assert.equal(event.returnValue, false); if (channel === 'apex:tauriStorage') assert.deepEqual(event.returnValue, {});
    }
    await stop(runResult); return { diagnostic: 'Direct calls to unmodified production handlers with actual generated WebContents/frame objects; this does not expose IPC to generated code.', invocations: results };
  });
  await group('clipboard, filesystem, camera/microphone/display, location and device permission APIs', async () => {
    const runResult = await run('permission-authority');
    if (focused) {
      runResult.page.focus();
      await runResult.child.executeJavaScript('document.getElementById("probe-button").focus();', true);
      await until(() => runResult.child.executeJavaScript('document.hasFocus()'));
    }
    const focusState = await runResult.child.executeJavaScript('({focused:document.hasFocus(),secure:isSecureContext,activation:navigator.userActivation.isActive})', true);
    const result = await childReport(runResult, `
      await read('openPicker',()=>showOpenFilePicker());await read('savePicker',()=>showSaveFilePicker());await read('directoryPicker',()=>showDirectoryPicker());
      await read('clipboardRead',async()=>{await navigator.clipboard.readText();return 'read-succeeded-content-not-recorded'});
      ${focused ? "await read('clipboardWritePermission',async()=>({state:(await navigator.permissions.query({name:'clipboard-write'})).state}));" : "await read('clipboardWrite',()=>navigator.clipboard.writeText('GENERATED_CLIPBOARD_PROBE'));"}
      await read('camera',()=>navigator.mediaDevices.getUserMedia({video:true}));await read('microphone',()=>navigator.mediaDevices.getUserMedia({audio:true}));
      await read('display',()=>navigator.mediaDevices.getDisplayMedia({video:true}));await read('enumerateMedia',async()=>(await navigator.mediaDevices.enumerateDevices()).map(d=>({kind:d.kind,deviceId:d.deviceId,groupId:d.groupId,label:d.label})));
      await read('geolocation',()=>new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(res,rej,{timeout:1000})));
      await read('usb',()=>navigator.usb.getDevices());await read('hid',()=>navigator.hid.getDevices());await read('serial',()=>navigator.serial.getPorts());
      await read('bluetooth',()=>navigator.bluetooth.requestDevice({acceptAllDevices:true}));await read('midi',()=>navigator.requestMIDIAccess());
      await read('storageDirectory',()=>navigator.storage.getDirectory());await read('storagePersist',()=>navigator.storage.persist());
      await read('fullscreen',()=>document.documentElement.requestFullscreen());`, true);
    for (const key of ['openPicker','savePicker','directoryPicker','clipboardRead','camera','microphone','display','geolocation','usb','hid','serial','bluetooth','midi','storageDirectory','fullscreen']) assert.ok(result[key].error, key);
    if (focused) { assert.equal(focusState.focused, true); assert.equal(focusState.activation, true); assert.equal(result.clipboardWritePermission.value?.state, 'denied'); }
    else assert.ok(result.clipboardWrite.error);
    if (result.enumerateMedia.value) assert.deepEqual(result.enumerateMedia.value, [], 'Deny-all media policy must not disclose device entries');
    if (result.storagePersist.value !== undefined) assert.equal(result.storagePersist.value, false);
    await stop(runResult); return { userGestureDiagnostic: true, focusState, results: result, clipboardWriteInvoked: !focused };
  });
  await group('file input programmatic/label/native pointer activation and hostile handler bypass', async () => {
    const runResult = await run('file-activation', `window.fileEvents=[];window.HTMLElement.prototype.matches=()=>false;window.Element.prototype.closest=()=>null;addEventListener('click',e=>{fileEvents.push('click-received');e.target.disabled=false},true);document.getElementById('file').onchange=()=>fileEvents.push('file-delivered');`, '<label id="file-label" for="file">Choose file</label><input type="file" id="file"><button id="probe-button">Probe</button>');
    const result = await childReport(runResult, `await read('click',()=>document.getElementById('file').click());await read('showPicker',()=>document.getElementById('file').showPicker());await read('labelClick',()=>document.getElementById('file-label').click());await read('fileState',()=>({disabled:document.getElementById('file').disabled,files:document.getElementById('file').files.length,events:window.fileEvents}));`, true);
    assert.ok(result.click.error); assert.ok(result.showPicker.error); assert.equal(result.fileState.value.files, 0); assert.equal(result.fileState.value.disabled, true);
    // Native renderer input path, rather than dispatchEvent's untrusted event.
    const labelRect = await runResult.child.executeJavaScript('(()=>{const r=document.getElementById("file-label").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),width:r.width,height:r.height}})()');
    runResult.page.sendInputEvent({ type: 'mouseDown', x: labelRect.x, y: labelRect.y, button: 'left', clickCount: 1 });
    runResult.page.sendInputEvent({ type: 'mouseUp', x: labelRect.x, y: labelRect.y, button: 'left', clickCount: 1 });
    await sleep(250); assert.equal(await runResult.child.executeJavaScript('document.getElementById("file").files.length'), 0);
    assert.ok(evidence.observations.some(row => row.runId === runResult.runId && row.type === 'file-guard-target-ready' && row.targetType === 'iframe'), 'OOPIF native chooser interception armed before payload');
    await stop(runResult); return { results: result, nativePointerInjected: true, labelRect, chooserDelivered: false };
  });
  for (const mode of ['open', 'closed']) await group(`native file chooser interception protects ${mode} shadow-root file inputs`, async () => {
    // Shadow inputs evade document.querySelectorAll and retarget the Window
    // capture event to their host. This reaches the native CDP chooser guard;
    // disabling that guard must fail this gate rather than open a file dialog.
    const marker = `SHADOW_FILE_NATIVE_CLICK:${mode}`;
    const runResult = await run(`shadow-file-${mode}`, `const host=document.createElement('div');host.id='shadow-file-host';document.body.append(host);const root=host.attachShadow({mode:${JSON.stringify(mode)}});const input=document.createElement('input');input.type='file';input.style.cssText='display:block;width:400px;height:70px';root.append(input);window.__shadowFile=input;input.addEventListener('click',e=>{if(e.isTrusted)console.log(${JSON.stringify(marker)})});input.addEventListener('change',()=>console.log('SHADOW_FILE_DELIVERED'));`, '<p>Native shadow file chooser fixture</p>');
    const before = await runResult.child.executeJavaScript(`(()=>{const input=window.__shadowFile,r=input.getBoundingClientRect();return {mode:${JSON.stringify(mode)},disabled:input.disabled,files:input.files.length,lightDomFiles:document.querySelectorAll('input[type="file"]').length,x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    assert.equal(before.disabled, false); assert.equal(before.files, 0); assert.equal(before.lightDomFiles, 0);
    const targets = await runResult.page.debugger.sendCommand('Target.getTargets');
    const target = targets.targetInfos.find(info => info.type === 'iframe' && info.url === 'about:srcdoc');
    assert.ok(target, 'Native pointer must reach the real opaque out-of-process child');
    const { sessionId } = await runResult.page.debugger.sendCommand('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    let dispatchError;
    try {
      runResult.page.focus();
      await runResult.page.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.x, y: before.y, button: 'left', clickCount: 1 }, sessionId);
      await runResult.page.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.x, y: before.y, button: 'left', clickCount: 1 }, sessionId);
    } catch (error) { dispatchError = error.message; }
    finally {
      // The expected chooser interception destroys its target and debugger.
      if (!runResult.page.isDestroyed()) await runResult.page.debugger.sendCommand('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
    const stopped = await until(() => eventFor(runResult, 'stopped'));
    assert.match(stopped.reason, /File selection is unavailable/);
    const consoleMessages = evidence.observations.filter(row => row.runId === runResult.runId && row.type === 'renderer-console').map(row => row.message);
    assert.ok(consoleMessages.includes(marker), 'A trusted browser click must reach the enabled shadow file input');
    assert.ok(!consoleMessages.includes('SHADOW_FILE_DELIVERED'), 'No selected file may reach the generated frame');
    await stop(runResult);
    return { before, nativeChildPointerInjected: true, chooserIntercepted: true, stoppedReason: stopped.reason, dispatchError, fileDelivered: false };
  });
  await group('drop and paste bytes never reach generated handlers', async () => {
    const runResult = await run('drop-paste', `window.inputEvents=[];for(const t of ['drop','paste','dragenter','dragover'])addEventListener(t,e=>inputEvents.push({type:t,text:e.clipboardData?.getData('text/plain')||e.dataTransfer?.getData('text/plain'),files:e.dataTransfer?.files.length}),true);`);
    const results = await runResult.child.executeJavaScript(`(()=>{const dt=new DataTransfer();dt.items.add(new File(['FILE_CANARY_DO_NOT_DELIVER'],'isolated-canary.txt'));dt.setData('text/plain','PASTE_CANARY_DO_NOT_DELIVER');const target=document.getElementById('probe-button');const drop=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt});target.dispatchEvent(drop);const paste=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt});target.dispatchEvent(paste);return {events:window.inputEvents,dropPrevented:drop.defaultPrevented,pastePrevented:paste.defaultPrevented}})()`);
    assert.deepEqual(results.events, []); assert.equal(results.dropPrevented, true); assert.equal(results.pastePrevented, true);
    // Browser-side CDP file drop uses a real file from the isolated test folder.
    let nativeDrop;
    try { nativeDrop = await nativeDropFile(runResult.page, 80, 40, [{ mimeType: 'text/plain', data: 'DROP_TEXT_CANARY' }]); }
    catch (error) { nativeDrop = { error: error.message }; }
    await sleep(150); assert.deepEqual(await runResult.child.executeJavaScript('window.inputEvents'), []);
    await stop(runResult); return { results, nativeDrop, nativeOSPasteTested: false };
  });
  await group('copy, cut and execCommand cannot write the clipboard', async () => {
    // Synthetic events and refused commands only, without a user gesture: the real clipboard is never read or written.
    const runResult = await run('clipboard-write', `window.clipboardEvents=[];for(const t of ['copy','cut'])addEventListener(t,e=>{clipboardEvents.push(t);e.clipboardData?.setData('text/plain','CLIPBOARD_CANARY_DO_NOT_WRITE');e.preventDefault();},true);`);
    const results = await runResult.child.executeJavaScript(`(()=>{const out={};for(const t of ['copy','cut']){const e=new ClipboardEvent(t,{bubbles:true,cancelable:true,clipboardData:new DataTransfer()});document.getElementById('probe-button').dispatchEvent(e);out[t+'Prevented']=e.defaultPrevented;}for(const c of ['copy','cut','paste']){try{out['exec-'+c]=String(document.execCommand(c));}catch(e){out['exec-'+c]=e.message;}}out.events=window.clipboardEvents;return out;})()`);
    assert.deepEqual(results.events, [], 'Model copy/cut handlers must never run');
    assert.equal(results.copyPrevented, true); assert.equal(results.cutPrevented, true);
    for (const command of ['copy', 'cut', 'paste']) assert.match(results[`exec-${command}`], /clipboard is unavailable/, command);
    await stop(runResult); return { results, realClipboardTouched: false };
  });
  await group('document.open/write/writeln cannot erase native drop and paste guards', async () => {
    const runResult = await run('document-stream-guards', `window.documentAttempts=[];for(const target of [document,Document.prototype])for(const name of ['open','write','writeln']){try{Reflect.apply(target[name],document,name==='open'?[]:['<button id="probe-button">Probe</button>']);documentAttempts.push({target:target===document?'own':'prototype',name,blocked:false});}catch(e){documentAttempts.push({target:target===document?'own':'prototype',name,blocked:true,error:e.name});}}try{document.close()}catch{};window.inputEvents=[];for(const t of ['dragenter','dragover'])addEventListener(t,e=>e.preventDefault(),true);for(const t of ['drop','paste'])addEventListener(t,e=>{inputEvents.push({type:t,text:e.clipboardData?.getData('text/plain')||e.dataTransfer?.getData('text/plain'),files:e.dataTransfer?.files.length});if(e.dataTransfer?.files[0])e.dataTransfer.files[0].text().then(text=>{window.nativeDroppedFile=text;generatedUI.discuss('FILE_LEAK:'+text)});},true);`);
    const attempts = await runResult.child.executeJavaScript('window.documentAttempts');
    const synthetic = await runResult.child.executeJavaScript(`(()=>{const dt=new DataTransfer();dt.setData('text/plain','DOCUMENT_OPEN_PASTE_CANARY');document.body.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));document.body.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));return window.inputEvents})()`);
    const dropRoute = await nativeDropFile(runResult.page, 50, 40);
    await sleep(150);
    const native = await runResult.child.executeJavaScript('({events:window.inputEvents,nativeDroppedFile:window.nativeDroppedFile})');
    evidence.observations.push({ type: 'document-stream-attack-receipt', runId: runResult.runId, attempts, synthetic, native, dropRoute });
    assert.equal(attempts.length, 6); assert.ok(attempts.every(row => row.blocked), 'All Document prototype and own streaming methods must reject generated code');
    assert.deepEqual(synthetic, [], 'Document replacement must not expose pasted or dropped text');
    assert.deepEqual(native.events, [], 'Document replacement must not expose native file drops');
    assert.equal(native.nativeDroppedFile, undefined);
    await stop(runResult); return { attempts, synthetic, native, dropRoute, actualIsolatedFileDrop: true };
  });
  await group('malformed/stale/oversized/wrong-source/port-bearing messages cannot stage draft or send', async () => {
    const runResult = await run('message-authority'); const binding = { protocolVersion: 1, runId: runResult.runId, revisionDigest: runResult.revisionDigest };
    const malformed = [null, [], {}, { ...binding, type: 'discuss', text: 'ATTACK_EXTRA', extra: true }, { ...binding, type: 'discuss', text: 'ATTACK_STALE', runId: 'stale-run' }, { ...binding, type: 'discuss', text: 'ATTACK_DIGEST', revisionDigest: 'f'.repeat(64) }, { ...binding, type: 'discuss', text: 'x'.repeat(4001) }, { ...binding, type: 'resize', height: '500' }, { ...binding, type: 'resize', height: Infinity }, { ...binding, type: 'daemon:send', text: 'ATTACK_SEND' }];
    await runResult.child.executeJavaScript(`for(const v of ${JSON.stringify(malformed)})parent.postMessage(v,'*');const m=new MessageChannel();parent.postMessage(${JSON.stringify({ ...binding, type: 'discuss', text: 'ATTACK_PORT' })},'*',[m.port2]);`);
    await runResult.page.executeJavaScript(`postMessage(${JSON.stringify({ ...binding, type: 'discuss', text: 'ATTACK_WRONG_SOURCE' })},'*');`);
    const before = evidence.events.filter(row => row.type === 'discuss').length;
    manager.receive({ sender: runResult.page, senderFrame: runResult.child }, { ...binding, type: 'discuss', text: 'ATTACK_WRONG_FRAME' });
    manager.receive({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, { ...binding, type: 'discuss', text: 'ATTACK_WRONG_CONTENTS' });
    manager.receive({ sender: runResult.page, senderFrame: runResult.page.mainFrame, ports: [{}] }, { ...binding, type: 'discuss', text: 'ATTACK_MAIN_PORT' });
    await sleep(300); assert.equal(evidence.events.filter(row => row.type === 'discuss').length, before);
    await runResult.child.executeJavaScript('generatedUI.discuss("UNTRUSTED_REVIEW_TEXT");');
    await until(() => eventFor(runResult, 'discuss')); assert.equal(eventFor(runResult, 'discuss').text, 'UNTRUSTED_REVIEW_TEXT');
    await checkCanaries(); await stop(runResult);
    // Late traffic from a disposed wrapper cannot revive its authority.
    manager.receive({ sender: runResult.page, senderFrame: null }, { ...binding, type: 'discuss', text: 'ATTACK_DISPOSED' });
    assert.equal(evidence.events.filter(row => row.runId === runResult.runId && row.type === 'discuss').length, 1);
    return { malformedCount: malformed.length, transferredPorts: true, wrongSource: true, wrongFrame: true, staleDisposed: true, discussOnlyStaged: true };
  });
  await group('port-bearing malformed message flood disposes host and preserves real Deck/daemon', async () => {
    const runResult = await run('port-flood');
    await runResult.child.executeJavaScript(`for(let i=0;i<100;i++){const c=new MessageChannel();parent.postMessage({type:'invalid',text:'ATTACK'},'*',[c.port2]);}`);
    const stopped = await until(() => eventFor(runResult, 'stopped')); assert.match(stopped.reason, /too many messages/);
    await stop(runResult); return { reason: stopped.reason };
  });
  for (const fixture of [
    { id: 'popup-denied', code: `window.__results={popup:window.open('https://external-authority.invalid/popup')===null};` },
    { id: 'form-denied', code: `const f=document.createElement('form');f.action='https://external-authority.invalid/form';f.method='post';document.body.append(f);f.submit();window.__results={formSubmitted:true};` },
    { id: 'download-denied', code: `const a=document.createElement('a');a.href='data:text/plain,DOWNLOAD_CANARY';a.download='generated-attack.txt';document.body.append(a);a.click();window.__results={downloadAttempted:true};` },
    { id: 'app-protocol-navigation', code: `location.href='app://deck/';` },
    { id: 'external-protocol-navigation', code: `location.href='apex-deck-authority-test://open';` },
    { id: 'top-external-forwarding', code: `try{top.location.href='https://external-authority.invalid/top'}catch(e){window.__denied=e.name}const a=document.createElement('a');a.href='https://external-authority.invalid/link';a.target='_blank';document.body.append(a);a.click();` },
    { id: 'file-protocol-navigation', code: `location.href=${JSON.stringify(pathToFileURL(fileCanary).href)};` },
  ]) await group(`forms/popups/downloads/protocols/external forwarding: ${fixture.id}`, async () => {
    const runResult = await run(fixture.id); let immediate;
    try { immediate = await runResult.child.executeJavaScript(`(()=>{${fixture.code};return {popup:window.__results?.popup,formSubmitted:window.__results?.formSubmitted,downloadAttempted:window.__results?.downloadAttempted,topDenied:window.__denied,childURL:location.href}})()`, true); } catch (error) { evidence.observations.push({ type: 'expected-probe-document-disposal', runId: runResult.runId, error: error.message }); }
    await sleep(350); const stopped = eventFor(runResult, 'stopped');
    const results = stopped ? null : await runResult.child.executeJavaScript('({popup:window.__results?.popup,topDenied:window.__denied,childURL:location.href})').catch(() => null);
    if (fixture.id === 'popup-denied') assert.equal(immediate?.popup, true);
    if (fixture.id === 'form-denied') assert.equal(immediate?.formSubmitted, true);
    if (fixture.id === 'download-denied') assert.equal(immediate?.downloadAttempted, true);
    await stop(runResult); return { stoppedReason: stopped?.reason, immediate, results, forwarded: evidence.externalCalls.slice(forbiddenStart.external), nativeDialogs: evidence.dialogCalls.slice(forbiddenStart.dialogs) };
  });
  await checkCanaries(); evidence.passed = evidence.failures.length === 0; evidence.releaseAccepted = false;
} catch (error) { evidence.passed = false; evidence.error = error.stack || String(error); }
finally {
  clearInterval(renewing); ipcMain.removeListener('generated-ui:message', receive);
  await manager?.stopAll('Authority gates finished.'); daemon?.close();
  if (nativeClipboard) { try { evidence.nativePasteboardCleanup = await nativeClipboard.close(); } catch { evidence.nativePasteboardCleanup = { ok: false }; evidence.passed = false; } }
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'authority-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: evidence.passed, failures: evidence.failures, error: evidence.error, groups: evidence.probes.map(({ name, passed, error }) => ({ name, passed, error })) }, null, 2));
  // app.exit closes its owned daemon stdin without invoking live quit dialogs.
  app.exit(evidence.passed ? 0 : 1);
}}
void app.whenReady().then(probe);
