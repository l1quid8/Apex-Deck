// Apex Deck's Electron main process: the windows, the app:// protocol that
// serves the built UI, and a byte pipe between each window and apex-daemon.
// A window speaks the protocol itself (src/daemon/client.ts); main only
// relays lines and does what needs the machine with the screen. Each window
// runs on one host, this Mac or another machine, so two can sit side by side.

import { app, BrowserWindow, dialog, ipcMain, Menu, net, powerMonitor, protocol, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dockedBrowser, flushProfile } from './browser.mjs';
import { appFile, safeName, startupFolders, writeNew } from './files.mjs';
import { LOCAL, LOCAL_NAME, loadHosts, saveHosts, validHost, assertHostUnused } from './hosts.mjs';
import { openTauriApps, tauriStorage } from './legacy.mjs';
import { socketLink, sshLink } from './link.mjs';
import { createHostLinks } from './hostLinks.mjs';
import { bindHostIdentity, checkWelcome, verifiedLink } from './hostIdentity.mjs';
import { QuitGate } from './quit.mjs';
import { daemonBinary, localDaemon } from './sidecar.mjs';
import { beginPdfExport, pdfPageSize, pdfRequestAllowed } from './pdfExport.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const dist = path.join(repo, 'dist');
const env = process.env;
const smoke = env.APEX_DECK_SMOKE === '1';
const devUrl = env.APEX_DECK_DEV_URL || '';
/** Set for tests and the smoke run: the host's data folder. */
const dataDir = env.APEX_DECK_DATA_DIR || undefined;
/** `scheme://host`; URL's own `origin` is "null" for schemes it doesn't know, like app:. */
const originOf = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
};
const UI_ORIGINS = new Set(['app://deck', devUrl && originOf(devUrl)].filter(Boolean));

app.setName('Apex Deck');
// The browser profile and the saved hosts live here, apart from the host's data.
app.setPath('userData', dataDir ? `${dataDir}-desktop` : path.join(app.getPath('appData'), 'dev.apexdeck.desktop'));
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const bin = daemonBinary({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, repo, env });

/** The local daemon, once started or found. */
let local = null;
let starting = null;

/** The daemon on this Mac: the one Deck started if it's still running, else start or find one. */
function ensureLocal() {
  if (local?.owned && local.alive()) return Promise.resolve(local);
  starting ??= localDaemon({ bin, dataDir, log: (text) => process.stderr.write(`[apex-daemon] ${text}`) })
    .then((daemon) => (local = daemon))
    .finally(() => { starting = null; });
  return starting;
}

// ------------------------------------------------------------ hosts

const hostsFile = () => path.join(app.getPath('userData'), 'hosts.json');
/**
 * Saved hosts, the one last chosen (`last`) and those with a window open
 * (`windows`, for the next launch); read once the app is ready.
 */
let hosts = { version: 1, hosts: [], last: LOCAL };

/** The saved host `id`, or null for this Mac. */
const remoteHost = (id) => hosts.hosts.find((host) => host.id === id) ?? null;

/** Every host; `open` when a window is on it. */
function hostList() {
  const open = new Set([...windows.values()].map((entry) => entry.host));
  return [
    { id: LOCAL, name: LOCAL_NAME, remote: false, open: open.has(LOCAL) },
    ...hosts.hosts.map(host => ({ ...host, remote: true })),
  ];
}

function writeHosts() {
  saveHosts(hostsFile(), hosts);
  Menu.setApplicationMenu(menu());
}

function knownHost(id) {
  if (id !== LOCAL && !remoteHost(id)) throw new Error('There is no such host.');
}
function rememberWindows() {
  hosts = { ...hosts, last: LOCAL, windows: [LOCAL] };
  writeHosts();
}

/** Bring `entry`'s window to the front. */
function front(entry) {
  if (entry.win.isMinimized()) entry.win.restore();
  entry.win.show();
  entry.win.focus();
}

/** Each window can connect to many saved execution hosts. */
const links = createHostLinks({
  open: async (hostId, handlers) => {
    knownHost(hostId);
    const remote = remoteHost(hostId);
    return verifiedLink({
      open: callbacks => remote ? sshLink(remote, callbacks) : ensureLocal().then(d => socketLink(d.socket, callbacks)),
      handlers,
      accept: welcome => {
        if (!remote) { checkWelcome(undefined, welcome); return; }
        const next = bindHostIdentity(hosts, hostId, welcome);
        saveHosts(hostsFile(), next); // persist before the renderer can send anything
        hosts = next;
      },
    });
  },
  emit: (contentsId, hostId, gen, channel, value) => {
    const entry = [...windows.values()].find(e => e.win.webContents.id === contentsId);
    if (entry && !entry.win.webContents.isDestroyed()) entry.win.webContents.send(channel, hostId, gen, value);
  },
});

/** The Deck window event came from, never a docked page or child frame. */
function deckWindow(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || !UI_ORIGINS.has(originOf(frame.url))) return null;
  return windows.get(BrowserWindow.fromWebContents(event.sender)?.id) ?? null;
}
const fromUi = event => deckWindow(event) !== null;
const watchedContents = new Set();
ipcMain.handle('daemon:connect', async (event, hostId = LOCAL) => {
  if (!fromUi(event)) throw new Error('Not the Deck window.');
  knownHost(hostId);
  const contents = event.sender;
  if (!watchedContents.has(contents.id)) {
    watchedContents.add(contents.id);
    contents.once('destroyed', () => { links.destroy(contents.id); watchedContents.delete(contents.id); });
    contents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) links.destroy(contents.id); });
  }
  return links.connect(contents.id, hostId);
});
ipcMain.on('daemon:send', (event, hostId, gen, line) => {
  if (!fromUi(event) || typeof line !== 'string') return;
  let frame; try { frame = JSON.parse(line); } catch { return; }
  if (hostId !== LOCAL && ['session_save', 'settings_save', 'decision_key_save'].includes(frame.cmd)) {
    event.sender.send('daemon:line', hostId, gen, JSON.stringify({ id: frame.id, err: 'App preferences are owned by This Mac.' }));
    return;
  }
  links.send(event.sender.id, hostId, gen, line);
});
ipcMain.on('daemon:close', (event, hostId, gen) => { if (fromUi(event)) links.close(event.sender.id, hostId, gen); });

ipcMain.on('apex:smoke', (event) => { event.returnValue = smoke; });

/** What the Tauri app kept in its window's storage, read once for preload.cjs to copy over. */
let tauriItems = null;
ipcMain.on('apex:tauriStorage', (event) => {
  // A test's data folder never takes this Mac's; APEX_DECK_TAURI_HOME gives it a home to read instead.
  const home = dataDir ? env.APEX_DECK_TAURI_HOME : app.getPath('home');
  if (fromUi(event) && home) tauriItems ??= tauriStorage(home);
  event.returnValue = (fromUi(event) && tauriItems) || {};
});

// ------------------------------------------------------------ the shell's jobs
// What the person saves or opens lands on this machine, the one with the screen.

/** Every Deck window by BrowserWindow id: `{ win, host, browser, badge }`. */
const windows = new Map();

/** Handle `channel` only for a Deck window's own page; `run` gets that window first. */
function handle(channel, run) {
  ipcMain.handle(channel, (event, ...args) => {
    const entry = deckWindow(event);
    if (!entry) throw new Error('Not the Deck window.');
    return run(entry, ...args);
  });
}

handle('connection:current', async ({ host }) => {
  const remote = remoteHost(host);
  if (remote) return { id: remote.id, name: remote.name, remote: true, owned: false };
  const daemon = await ensureLocal().catch(() => null);
  return { id: LOCAL, name: LOCAL_NAME, remote: false, owned: daemon?.owned ?? true };
});

handle('shell:pickPath', async ({ win }, kind, title) => {
  const picked = await dialog.showOpenDialog(win, {
    title: String(title || ''),
    properties: [kind === 'directory' ? 'openDirectory' : 'openFile', 'createDirectory'],
  });
  return picked.canceled ? null : (picked.filePaths[0] ?? null);
});

handle('shell:saveFile', async ({ win }, name, contents) => {
  const picked = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), safeName(name)) });
  if (picked.canceled || !picked.filePath) return null;
  await fs.promises.writeFile(picked.filePath, String(contents));
  return picked.filePath;
});

handle('shell:exportFile', async (_entry, name, contents) => {
  try {
    return writeNew(app.getPath('downloads'), name, String(contents));
  } catch (e) {
    throw new Error(`Could not save the export: ${e.message}`);
  }
});

handle('shell:exportPdf', async (_entry, name, html) => {
  const documentUrl = `data:text/html;charset=utf-8,${encodeURIComponent(String(html ?? ''))}`;
  const partition = `pdf-export-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const ses = session.fromPartition(partition);
  const block = (details, callback) => callback({ cancel: !pdfRequestAllowed(details.url, documentUrl) });
  ses.webRequest.onBeforeRequest(block);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition,
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const contents = win.webContents;
  const stopNav = (event) => event.preventDefault();
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', stopNav);
  contents.on('will-redirect', stopNav);
  contents.on('will-attach-webview', stopNav);
  ses.on('will-download', stopNav);
  const job = beginPdfExport();
  try {
    const printed = await new Promise((resolve, reject) => {
      job.arm(30_000, () => {
        if (!win.isDestroyed()) win.destroy();
        reject(new Error('Making the PDF took too long.'));
      });
      win.loadURL(documentUrl).then(() => contents.printToPDF({
        printBackground: true,
        pageSize: pdfPageSize(app.getLocale()),
        margins: { marginType: 'none' },
      })).then(resolve, reject);
    });
    if (!job.commit()) throw new Error('Making the PDF took too long.');
    return writeNew(app.getPath('downloads'), name, Buffer.from(printed));
  } finally {
    job.abort();
    if (!win.isDestroyed()) win.destroy();
  }
});

handle('shell:openArtifact', async (_entry, name, contents) => {
  // Opened in its default app, outside the sandbox; kept apart from Downloads.
  const file = writeNew(path.join(app.getPath('userData'), 'exports'), name, String(contents));
  const problem = await shell.openPath(file);
  if (problem) throw new Error(problem);
});

handle('shell:openExternal', async (_entry, url) => openExternally(url));

/** The most a dropped file sent to another machine may be. */
const SEND_LIMIT = 20 * 1024 * 1024;

handle('shell:readLocalFile', async (_entry, host, file) => {
  // Only for sending a dropped file to another machine.
  const remote = remoteHost(host);
  if (!remote) throw new Error('This Mac reads its own files.');
  const info = await fs.promises.stat(String(file));
  if (info.isDirectory()) throw new Error(`Folders can't be sent to ${remote.name}; drop the files in it instead.`);
  if (info.size > SEND_LIMIT) throw new Error(`${path.basename(String(file))} is over 20 MB, too large to send to ${remote.name}.`);
  return fs.promises.readFile(String(file));
});

handle('connection:list', async () => hostList());
handle('connection:add', async (_entry, host) => {
  const valid = validHost(host ?? {}, hosts.hosts.map((h) => h.name));
  hosts = { ...hosts, hosts: [...hosts.hosts, { id: `h-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...valid }] };
  writeHosts();
  return hostList();
});
handle('connection:references', async (entry, ids) => {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Invalid workspace host references.');
  entry.references = [...new Set(ids)];
});
handle('connection:remove', async (entry, id) => {
  knownHost(id);
  const daemon = await ensureLocal();
  const file = path.join(path.dirname(daemon.socket), 'saved-chats-v1', 'session.json');
  let session;
  try { session = JSON.parse(await fs.promises.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') session = { workspaces: [] }; else throw new Error('Could not read the saved workspace list; the server was kept.'); }
  assertHostUnused(id, session, entry.references);
  const next = { ...hosts, hosts: hosts.hosts.filter(h => h.id !== id), last: LOCAL, windows: [LOCAL] };
  saveHosts(hostsFile(), next); hosts = next; links.removeHost(id);
  Menu.setApplicationMenu(menu());
  return hostList();
});

/** The dock's count: what every window is waiting on. */
handle('shell:setBadge', async (entry, count) => {
  entry.badge = Math.max(0, Number(count) || 0);
  app.setBadgeCount([...windows.values()].reduce((sum, e) => sum + e.badge, 0));
});

handle('shell:attention', async ({ win }, critical) => {
  if (process.platform === 'darwin') app.dock?.bounce(critical ? 'critical' : 'informational');
  else win.flashFrame(true);
});

handle('shell:startupFolders', async () => startupFolders(process.argv, app.isPackaged, (folder) => {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}));

// ------------------------------------------------------------ quitting

/** Set once quitting is under way. */
let finishing = false;

/** Quit now: the person chose to, nothing was running, the window never answered, or the system is logging out. */
async function finishQuit() {
  if (finishing) return;
  finishing = true;
  gate.confirm();
  // Sign-ins in the docked browser last: app.exit doesn't wait for Chromium to save them.
  await flushProfile();
  // The daemon Deck started ends with it; a daemon it found goes on.
  if (local?.owned) await local.stop();
  app.exit(0);
}

const gate = new QuitGate({ letThrough: () => void finishQuit() });

/**
 * Hold a close or quit and ask a window; false when nothing holds it. Quitting
 * asks `entry`, else a window on this Mac (its work is what stops), else the one in front.
 */
function askToQuit(entry) {
  const request = gate.request();
  if (request === null) return false;
  const all = [...windows.values()];
  const asked = entry ?? all.find((e) => e.host === LOCAL) ?? windows.get(BrowserWindow.getFocusedWindow()?.id) ?? all[0];
  if (asked && !asked.win.isDestroyed()) asked.win.webContents.send('quit-requested', request);
  return true;
}

handle('shell:quitHeard', async (_entry, request) => gate.heard(Number(request)));
handle('shell:quitApp', async () => finishQuit());

// ------------------------------------------------------------ the docked browser

const BOUNDS = (b) => ({ x: Math.round(Number(b?.x) || 0), y: Math.round(Number(b?.y) || 0), width: Math.max(0, Math.round(Number(b?.width) || 0)), height: Math.max(0, Math.round(Number(b?.height) || 0)) });
handle('browser:show', async ({ browser }, pane, bounds, url) => browser.show(String(pane), BOUNDS(bounds), String(url ?? '')));
handle('browser:hide', async ({ browser }, pane, snapshot) => browser.hide(String(pane), Boolean(snapshot)));
handle('browser:navigate', async ({ browser }, pane, url) => browser.navigate(String(pane), String(url)));
handle('browser:reload', async ({ browser }, pane) => browser.reload(String(pane)));
handle('browser:back', async ({ browser }, pane) => browser.back(String(pane)));
handle('browser:forward', async ({ browser }, pane) => browser.forward(String(pane)));
handle('browser:close', async ({ browser }, pane) => browser.close(String(pane)));
ipcMain.on('browser:bounds', (event, pane, bounds) => {
  deckWindow(event)?.browser.bounds(String(pane), BOUNDS(bounds));
});

/** The Deck window in front, or any. */
const frontWindow = () => windows.get(BrowserWindow.getFocusedWindow()?.id) ?? [...windows.values()].at(-1) ?? null;

function menu() {
  const toWindow = (action) => () => frontWindow()?.win.webContents.send('menu', action);
  const mac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(mac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: toWindow('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { label: 'Servers', submenu: [{ label: 'Manage Servers…', click: toWindow('hosts') }] },
    { role: 'windowMenu' },
  ]);
}

function openExternally(url) {
  try {
    if (['http:', 'https:'].includes(new URL(url).protocol)) void shell.openExternal(url);
  } catch {
    // Not a URL; nothing to open.
  }
}

/** A Deck window on host `host`, a step down and right of `beside` when given. */
function createWindow(host, beside) {
  const near = beside && !beside.win.isDestroyed() ? beside.win.getBounds() : null;
  const win = new BrowserWindow({
    width: near?.width ?? 1400,
    height: near?.height ?? 900,
    ...(near ? { x: near.x + 28, y: near.y + 28 } : {}),
    minWidth: 900,
    minHeight: 600,
    title: 'Apex Deck',
    show: !smoke,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Keep the window's own name rather than the page's.
  win.on('page-title-updated', (event) => event.preventDefault());
  // The UI never navigates away from itself; links open in the browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (UI_ORIGINS.has(originOf(url))) return;
    event.preventDefault();
    openExternally(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  const browser = dockedBrowser({
    win,
    send: (channel, ...args) => { if (!win.isDestroyed()) win.webContents.send(channel, ...args); },
    downloads: () => app.getPath('downloads'),
  });
  const entry = { win, host: LOCAL, browser, badge: 0, references: null };
  windows.set(win.id, entry);
  // The window reloading takes the pages down with it; it shows them again as it comes back.
  win.webContents.on('did-start-navigation', (details, _url, inPlace, mainFrame) => {
    if ((details.isMainFrame ?? mainFrame) && !(details.isSameDocument ?? inPlace)) browser.hideAll();
  });
  // Closing the last window asks it first, like Quit. Any other just closes:
  // its host's work goes on, there or in this Mac's daemon.
  win.on('close', (event) => {
    if (windows.size === 1 && askToQuit(entry)) event.preventDefault();
  });
  win.on('closed', () => {
    browser.closeAll();
    windows.delete(win.id);
    // Windows closing as the app quits stay in the list, to open next time.
    if (!gate.confirmed && windows.size > 0) {
      app.setBadgeCount([...windows.values()].reduce((sum, e) => sum + e.badge, 0));
      rememberWindows();
    }
  });
  win.on('focus', () => Menu.setApplicationMenu(menu()));
  if (smoke) {
    // On screen, so pages can be captured, but invisible, click-through and
    // never focused, so a smoke run doesn't get in the way.
    win.setOpacity(0);
    win.setIgnoreMouseEvents(true);
    win.showInactive();
  }
  void win.loadURL(devUrl || 'app://deck/');
  return entry;
}

/**
 * Whether no Tauri Apex Deck is open, asking for it to be quit while one is.
 * v0.4.0 and before keep no lock on the data folder, so with both open each
 * would save over the other's threads and settings.
 */
function oldAppClosed() {
  while (openTauriApps().length > 0) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      message: 'Quit the older Apex Deck first',
      detail: 'An older Apex Deck (0.4.0 or before) is open. Both save the same threads and settings, so with both open, '
        + 'changes in one can overwrite the other. Quit it, then choose Continue.',
      buttons: ['Continue', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 1) return false;
  }
  return true;
}

app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    const file = appFile(dist, request.url);
    if (!file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  if (!dataDir && !oldAppClosed()) {
    app.exit(0);
    return;
  }
  const { state, warnings } = loadHosts(hostsFile());
  hosts = state;
  warnings.forEach((warning) => console.warn(`hosts: ${warning}`));
  Menu.setApplicationMenu(menu());
  // Each window a step down from the one before, so none hides another.
  const first = createWindow(LOCAL);
  rememberWindows();
  if (smoke) {
    const { runSmoke } = env.APEX_DECK_MULTI_HOST_ROOT ? { runSmoke: (await import('./multi-host-smoke.mjs')).runMultiHostSmoke } : await import('./smoke.mjs');
    const code = await runSmoke(first.win, { sidecar: () => local, browser: first.browser }).catch((e) => {
      console.error(`smoke: ${e.stack ?? e}`);
      return 1;
    });
    // null: the smoke run ended by quitting the way the person would.
    if (code !== null) {
      await local?.stop?.();
      app.exit(code);
    }
  }
});

// ⌘Q and Quit in the menu ask the window first. Once quitting is decided,
// it goes the one way that stops the daemon Deck started.
app.on('before-quit', (event) => {
  if (systemQuitting) return;
  if (gate.confirmed) {
    if (finishing) return;
    event.preventDefault();
    void finishQuit();
    return;
  }
  if (askToQuit()) event.preventDefault();
});

// Logging out, restarting or shutting down is never held, not even to wait
// for the daemon: holding it would cancel the logout. The daemon Deck started
// stops by itself when its stdin closes with the app.
let systemQuitting = false;
app.whenReady().then(() => powerMonitor.on('shutdown', () => {
  systemQuitting = true;
  gate.confirm();
}));
