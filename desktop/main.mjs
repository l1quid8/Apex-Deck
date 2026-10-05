// Apex Deck's Electron main process: the window, the app:// protocol that
// serves the built UI, and a byte pipe between the window and apex-daemon.
// The window speaks the protocol itself (src/daemon/client.ts); main only
// relays lines and does what needs the machine with the screen.

import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appFile } from './files.mjs';
import { socketLink } from './link.mjs';
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
  const daemon = await ensureLocal();
  const send = (channel, ...args) => { if (!contents.isDestroyed()) contents.send(channel, gen, ...args); };
  const link = await socketLink(daemon.socket, {
    onLine: (line) => send('daemon:line', line),
    onClose: (reason) => {
      if (state.gen === gen) state.link = null;
      send('daemon:close', reason);
    },
  });
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
  const daemon = await ensureLocal().catch(() => null);
  return { id: 'local', name: 'This Mac', remote: false, owned: daemon?.owned ?? true };
});

ipcMain.on('apex:smoke', (event) => { event.returnValue = smoke; });

function openExternally(url) {
  try {
    if (['http:', 'https:'].includes(new URL(url).protocol)) void shell.openExternal(url);
  } catch {
    // Not a URL; nothing to open.
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
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
  void win.loadURL(devUrl || 'app://deck/');
  return win;
}

app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    const file = appFile(dist, request.url);
    if (!file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  const win = createWindow();
  if (smoke) {
    const { runSmoke } = await import('./smoke.mjs');
    const code = await runSmoke(win).catch((e) => {
      console.error(`smoke: ${e.stack ?? e}`);
      return 1;
    });
    await local?.stop?.();
    app.exit(code);
  }
});

app.on('window-all-closed', () => app.quit());

let stopped = false;
app.on('will-quit', (event) => {
  // The daemon Deck started ends with it; give it time to wind down.
  if (stopped || !local?.owned) return;
  event.preventDefault();
  stopped = true;
  void local.stop().finally(() => app.quit());
});
