// Apex Deck's Electron main process: the window, the app:// protocol that
// serves the built UI, and a byte pipe between the window and apex-daemon.
// The window speaks the protocol itself (src/daemon/client.ts); main only
// relays lines and does what needs the machine with the screen.

import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dockedBrowser } from './browser.mjs';
import { appFile, safeName, startupFolders, writeNew } from './files.mjs';
import { LOCAL, LOCAL_NAME, loadHosts, saveHosts, validHost } from './hosts.mjs';
import { socketLink, sshLink } from './link.mjs';
import { QuitGate } from './quit.mjs';
import { daemonBinary, localDaemon } from './sidecar.mjs';

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
/** Saved hosts and the one in use (`last`); read once the app is ready. */
let hosts = { version: 1, hosts: [], last: LOCAL };

/** The saved host in use, or null for this Mac. */
const remoteHost = () => hosts.hosts.find((host) => host.id === hosts.last) ?? null;

function hostList() {
  return [
    { id: LOCAL, name: LOCAL_NAME, remote: false },
    ...hosts.hosts.map(({ id, name, ssh, command }) => ({ id, name, ssh, command, remote: true })),
  ];
}

function writeHosts() {
  saveHosts(hostsFile(), hosts);
  Menu.setApplicationMenu(menu());
}

const windowTitle = () => (remoteHost() ? `Apex Deck — ${remoteHost().name}` : 'Apex Deck');

/** Switch the window to host `id`: it reloads and connects there. */
function useHost(id) {
  if (id !== LOCAL && !hosts.hosts.some((host) => host.id === id)) throw new Error('There is no such host.');
  hosts = { ...hosts, last: id };
  writeHosts();
  if (!win || win.isDestroyed()) return;
  win.setTitle(windowTitle());
  for (const state of links.values()) state.link?.close();
  win.webContents.reload();
}

/** Each window's link to the daemon: a new generation on every connect. */
const links = new Map();

function fromUi(event) {
  const frame = event.senderFrame;
  return Boolean(frame && UI_ORIGINS.has(originOf(frame.url)) && BrowserWindow.fromWebContents(event.sender));
}

ipcMain.handle('daemon:connect', async (event) => {
  if (!fromUi(event)) throw new Error('Not the Deck window.');
  const contents = event.sender;
  let state = links.get(contents.id);
  if (!state) {
    state = { gen: 0, link: null };
    links.set(contents.id, state);
    contents.once('destroyed', () => {
      state.link?.close();
      links.delete(contents.id);
    });
  }
  state.link?.close();
  state.link = null;
  const gen = ++state.gen;
  const send = (channel, ...args) => { if (!contents.isDestroyed()) contents.send(channel, gen, ...args); };
  const handlers = {
    onLine: (line) => send('daemon:line', line),
    onClose: (reason) => {
      if (state.gen === gen) state.link = null;
      send('daemon:close', reason);
    },
  };
  const remote = remoteHost();
  const link = remote ? sshLink(remote, handlers) : await socketLink((await ensureLocal()).socket, handlers);
  if (state.gen !== gen) {
    link.close();
    throw new Error('A newer connection replaced this one.');
  }
  state.link = link;
  return gen;
});

ipcMain.on('daemon:send', (event, gen, line) => {
  const state = links.get(event.sender.id);
  if (fromUi(event) && state?.gen === gen && typeof line === 'string') state.link?.send(line);
});

ipcMain.on('daemon:close', (event, gen) => {
  const state = links.get(event.sender.id);
  if (fromUi(event) && state?.gen === gen) state.link?.close();
});

ipcMain.handle('connection:current', async () => {
  const remote = remoteHost();
  if (remote) return { id: remote.id, name: remote.name, remote: true, owned: false };
  const daemon = await ensureLocal().catch(() => null);
  return { id: LOCAL, name: LOCAL_NAME, remote: false, owned: daemon?.owned ?? true };
});

ipcMain.on('apex:smoke', (event) => { event.returnValue = smoke; });

// ------------------------------------------------------------ the shell's jobs
// What the person saves or opens lands on this machine, the one with the screen.

/** The main window, once made. */
let win = null;

/** Handle `channel` only for the Deck window's own page. */
function handle(channel, run) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromUi(event)) throw new Error('Not the Deck window.');
    return run(...args);
  });
}

handle('shell:pickPath', async (kind, title) => {
  const picked = await dialog.showOpenDialog(win, {
    title: String(title || ''),
    properties: [kind === 'directory' ? 'openDirectory' : 'openFile', 'createDirectory'],
  });
  return picked.canceled ? null : (picked.filePaths[0] ?? null);
});

handle('shell:saveFile', async (name, contents) => {
  const picked = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), safeName(name)) });
  if (picked.canceled || !picked.filePath) return null;
  await fs.promises.writeFile(picked.filePath, String(contents));
  return picked.filePath;
});

handle('shell:exportFile', async (name, contents) => {
  try {
    return writeNew(app.getPath('downloads'), name, String(contents));
  } catch (e) {
    throw new Error(`Could not save the export: ${e.message}`);
  }
});

handle('shell:openArtifact', async (name, contents) => {
  // Opened in its default app, outside the sandbox; kept apart from Downloads.
  const file = writeNew(path.join(app.getPath('userData'), 'exports'), name, String(contents));
  const problem = await shell.openPath(file);
  if (problem) throw new Error(problem);
});

handle('shell:openExternal', async (url) => openExternally(url));

/** The most a dropped file sent to another machine may be. */
const SEND_LIMIT = 20 * 1024 * 1024;

handle('shell:readLocalFile', async (file) => {
  // Only for sending a dropped file to another machine.
  const remote = remoteHost();
  if (!remote) throw new Error('This Mac reads its own files.');
  const info = await fs.promises.stat(String(file));
  if (info.isDirectory()) throw new Error(`Folders can't be sent to ${remote.name}; drop the files in it instead.`);
  if (info.size > SEND_LIMIT) throw new Error(`${path.basename(String(file))} is over 20 MB, too large to send to ${remote.name}.`);
  return fs.promises.readFile(String(file));
});

handle('connection:list', async () => hostList());
handle('connection:add', async (host) => {
  const valid = validHost(host ?? {}, hosts.hosts.map((h) => h.name));
  hosts = { ...hosts, hosts: [...hosts.hosts, { id: `h-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...valid }] };
  writeHosts();
  return hostList();
});
handle('connection:remove', async (id) => {
  const wasCurrent = hosts.last === id;
  hosts = { ...hosts, hosts: hosts.hosts.filter((h) => h.id !== id) };
  if (wasCurrent) useHost(LOCAL);
  else writeHosts();
  return hostList();
});
handle('connection:use', async (id) => useHost(String(id)));

handle('shell:setBadge', async (count) => {
  app.setBadgeCount(Math.max(0, Number(count) || 0));
});

handle('shell:attention', async (critical) => {
  if (process.platform === 'darwin') app.dock?.bounce(critical ? 'critical' : 'informational');
  else win?.flashFrame(true);
});

handle('shell:startupFolders', async () => startupFolders(process.argv, app.isPackaged, (folder) => {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}));

// ------------------------------------------------------------ quitting

/** Quit now: the person chose to, nothing was running, or the window never answered. */
async function finishQuit() {
  gate.confirm();
  // Sign-ins in the docked browser last: app.exit doesn't wait for Chromium to save them.
  await browser?.flush();
  // The daemon Deck started ends with it; a daemon it found goes on.
  if (local?.owned) await local.stop();
  app.exit(0);
}

const gate = new QuitGate({ letThrough: () => void finishQuit() });

/** Hold a close or quit and ask the window; false when nothing holds it. */
function askToQuit() {
  const request = gate.request();
  if (request === null) return false;
  if (win && !win.isDestroyed()) win.webContents.send('quit-requested', request);
  return true;
}

handle('shell:quitHeard', async (request) => gate.heard(Number(request)));
handle('shell:quitApp', async () => finishQuit());

// ------------------------------------------------------------ the docked browser

/** Made with the window. */
let browser = null;

const BOUNDS = (b) => ({ x: Math.round(Number(b?.x) || 0), y: Math.round(Number(b?.y) || 0), width: Math.max(0, Math.round(Number(b?.width) || 0)), height: Math.max(0, Math.round(Number(b?.height) || 0)) });
handle('browser:show', async (pane, bounds, url) => browser.show(String(pane), BOUNDS(bounds), String(url ?? '')));
handle('browser:hide', async (pane, snapshot) => browser.hide(String(pane), Boolean(snapshot)));
handle('browser:navigate', async (pane, url) => browser.navigate(String(pane), String(url)));
handle('browser:reload', async (pane) => browser.reload(String(pane)));
handle('browser:back', async (pane) => browser.back(String(pane)));
handle('browser:forward', async (pane) => browser.forward(String(pane)));
handle('browser:close', async (pane) => browser.close(String(pane)));
ipcMain.on('browser:bounds', (event, pane, bounds) => {
  if (fromUi(event)) browser?.bounds(String(pane), BOUNDS(bounds));
});

function menu() {
  const toWindow = (action) => () => win?.webContents.send('menu', action);
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
    {
      label: 'Host',
      submenu: [
        ...hostList().map((host) => ({
          label: host.name,
          type: 'radio',
          checked: host.id === (remoteHost()?.id ?? LOCAL),
          click: () => useHost(host.id),
        })),
        { type: 'separator' },
        { label: 'Manage Hosts…', click: toWindow('hosts') },
      ],
    },
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

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: windowTitle(),
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
  browser = dockedBrowser({
    win,
    send: (channel, ...args) => { if (!win.isDestroyed()) win.webContents.send(channel, ...args); },
    downloads: () => app.getPath('downloads'),
  });
  // The window reloading takes the pages down with it; it shows them again as it comes back.
  win.webContents.on('did-start-navigation', (details, _url, inPlace, mainFrame) => {
    if ((details.isMainFrame ?? mainFrame) && !(details.isSameDocument ?? inPlace)) browser.hideAll();
  });
  // The close button and ⌘W ask the window first, like Quit.
  win.on('close', (event) => {
    if (askToQuit()) event.preventDefault();
  });
  if (smoke) {
    // On screen, so pages can be captured, but invisible, click-through and
    // never focused, so a smoke run doesn't get in the way.
    win.setOpacity(0);
    win.setIgnoreMouseEvents(true);
    win.showInactive();
  }
  void win.loadURL(devUrl || 'app://deck/');
  return win;
}

app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    const file = appFile(dist, request.url);
    if (!file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  const { state, warnings } = loadHosts(hostsFile());
  hosts = state;
  warnings.forEach((warning) => console.warn(`hosts: ${warning}`));
  Menu.setApplicationMenu(menu());
  createWindow();
  if (smoke) {
    const { runSmoke } = await import('./smoke.mjs');
    const code = await runSmoke(win, { sidecar: () => local, browser }).catch((e) => {
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

// ⌘Q and Quit in the menu ask the window first.
app.on('before-quit', (event) => {
  if (askToQuit()) event.preventDefault();
});
