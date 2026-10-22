// Apex Deck's Electron main process: the windows, the app:// protocol that
// serves the built UI, and a byte pipe between each window and apex-daemon.
// A window speaks the protocol itself (src/daemon/client.ts); main only
// relays lines and does what needs the machine with the screen. Each window
// runs on one host, this Mac or another machine, so two can sit side by side.

import { app, BrowserWindow, dialog, ipcMain, Menu, net, powerMonitor, protocol, screen, session, shell, systemPreferences, WebContentsView, webContents } from 'electron';
import { VoiceRuntimeManager } from './voiceRuntime.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dockedBrowser, flushProfile } from './browser.mjs';
import { appFile, safeName, startupFolders, writeNew } from './files.mjs';
import { LOCAL, LOCAL_NAME, loadHosts, saveHosts, validHost, assertHostUnused } from './hosts.mjs';
import { openTauriApps, tauriStorage } from './legacy.mjs';
import { socketLink, sshLink } from './link.mjs';
import { createHostLinks } from './hostLinks.mjs';
import { applyHostUpdate, bindHostIdentity, checkWelcome, probeWelcome, verifiedLink } from './hostIdentity.mjs';
import { QuitGate } from './quit.mjs';
import { answers, daemonBinary, dataFolder, localDaemon, remoteAccessSaved, saveRemoteAccess } from './sidecar.mjs';
import { agentPlist, agentPlistPath, daemonBuild, installAgent, removeAgent, startAgentDaemon, usesLaunchAgent } from './launchAgent.mjs';
import { changeRemoteAccess } from './remoteSwitch.mjs';
import { beginPdfExport, pdfPageSize, pdfRequestAllowed } from './pdfExport.mjs';
import { installGeneratedUI } from './generated-ui/host.mjs';

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
/** Set while the daemon on this Mac is stopping to start again with Remote access changed. */
let restarting = null;

/** Settings → Remote access, kept with the app's own settings. */
const desktopSettingsFile = () => path.join(app.getPath('userData'), 'desktop-settings.json');
/** Read once the app is ready. Dev builds still pass it as `--remote`. The LaunchAgent does not: the daemon reads its own file. */
let remoteAccess = false;

/** Whether the daemon can run as a LaunchAgent, which outlives the app (see launchAgent.mjs). */
const agentMode = usesLaunchAgent({ packaged: app.isPackaged, dataDir });
/** On a packaged Mac the LaunchAgent always runs the daemon, phone connections on or off. */
const agentWanted = () => agentMode;
/** Where the agent's daemon writes its output: the app's logs folder. */
const agentLogFile = () => path.join(app.getPath('logs'), 'apex-daemon.log');
/** The daemon's `daemon.sock`, whichever way it was started. */
const socketFile = async () => path.join(await dataFolder(bin, dataDir), 'daemon.sock');

/** Install the LaunchAgent (or leave it as it is) and attach to the daemon it runs. */
async function startAgent() {
  const logFile = agentLogFile();
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const socket = await socketFile();
  const plistPath = agentPlistPath();
  const uid = process.getuid();
  const got = await startAgentDaemon({
    socket,
    infoFile: path.join(path.dirname(socket), 'daemon.json'),
    uid,
    answers,
    install: () => installAgent({ plistPath, plist: agentPlist({ bin, dataDir, logFile, build: daemonBuild(bin) }), uid }),
    remove: () => removeAgent({ plistPath, uid }),
  });
  // A daemon Deck didn't start keeps its own flags; Settings says so.
  if (got === 'foreign') return { socket, owned: false, child: null, alive: () => true, stop: async () => {} };
  return { socket, owned: false, agent: true, child: null, alive: () => true, stop: async () => {} };
}

/** A daemon Deck can restart: one it started, or the LaunchAgent (launchctl restarts that one). */
const restartable = (daemon) => daemon.owned || daemon.agent === true;

/** The daemon on this Mac: the one Deck started if it's still running, else start or find one. */
function ensureLocal() {
  if (restarting) return restarting.then(() => ensureLocal());
  if (local?.owned && local.alive()) return Promise.resolve(local);
  // launchd keeps the agent's daemon up; windows reconnect to it by themselves.
  if (local?.agent && agentWanted()) return Promise.resolve(local);
  starting ??= (agentWanted()
    ? startAgent()
    : localDaemon({ bin, dataDir, remote: remoteAccess, log: (text) => process.stderr.write(`[apex-daemon] ${text}`) }))
    .then((daemon) => (local = daemon))
    .finally(() => { starting = null; });
  return starting;
}

/**
 * Make this Mac's daemon match the Remote access setting, which is already
 * saved and set when this runs. A child daemon Deck started is stopped and
 * started again with the flag. The LaunchAgent is left running: phone
 * connections are the daemon's own setting (Task 1b switches that live).
 * A daemon Deck found running is left alone. Windows reconnect by themselves.
 */
async function restartLocal() {
  if (starting) await starting.catch(() => {});
  restarting ??= (async () => {
    const old = local;
    local = null;
    if (old?.owned && old.alive()) await old.stop();
  })().finally(() => { restarting = null; });
  await restarting;
  return ensureLocal();
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
    const entry = [...windows.values(), ...popoutWindows.values()].find(e => e.win.webContents.id === contentsId);
    if (entry && !entry.win.webContents.isDestroyed()) entry.win.webContents.send(channel, hostId, gen, value);
  },
});

/** The Deck window event came from, never a docked page or child frame. Pop-outs count as Deck windows. */
function deckWindow(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || !UI_ORIGINS.has(originOf(frame.url))) return null;
  const id = BrowserWindow.fromWebContents(event.sender)?.id;
  return windows.get(id) ?? popoutWindows.get(id) ?? null;
}
const fromUi = event => deckWindow(event) !== null;
const watchedContents = new Set();
// Google sign-in for Gmail and Drive. The system browser does the sign-in; the code comes back to a server on this Mac only.
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly';
const GOOGLE_SIGN_IN_MS = 5 * 60 * 1000;
const googlePage = (res, message) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Apex Deck</title><p style="font-family:system-ui">${message}</p>`);
};
ipcMain.handle('google:signIn', (event, { clientId, clientSecret } = {}) => {
  if (!fromUi(event)) throw new Error('Not the Deck window.');
  if (!clientId || !clientSecret) throw new Error('Enter the OAuth client ID and secret first.');
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const server = http.createServer();
    let redirectUri = '';
    let timer = null;
    let settled = false;
    const finish = (failure, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (failure) reject(failure);
      else resolve(value);
    };
    server.on('request', async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/') { res.writeHead(404).end(); return; }
      const code = url.searchParams.get('code');
      const failed = url.searchParams.get('error');
      if (failed || !code || url.searchParams.get('state') !== state) {
        googlePage(res, 'Sign-in was not completed. You can close this tab.');
        finish(new Error(failed ? `Google said: ${failed}` : 'Google sign-in did not match this request.'));
        return;
      }
      googlePage(res, 'You can close this tab.');
      try {
        const response = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri }),
        });
        const body = await response.json();
        if (!response.ok || !body.refresh_token) throw new Error(body.error_description ?? body.error ?? 'Google did not return a refresh token.');
        finish(null, { refreshToken: body.refresh_token });
      } catch (cause) {
        finish(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
    timer = setTimeout(() => finish(new Error('Google sign-in timed out. Try again.')), GOOGLE_SIGN_IN_MS);
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`;
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: GOOGLE_SCOPES,
        access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
      }).toString();
      shell.openExternal(auth.toString()).catch((cause) => finish(cause instanceof Error ? cause : new Error(String(cause))));
    });
  });
});
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

ipcMain.on('apex:smoke', (event) => { event.returnValue = fromUi(event) && smoke; });

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

// Generated code lives in a dedicated host/session, never in the chat renderer.
// Main admits only the independently verified runtime/policy registry tuple.
installGeneratedUI({ electron: { app, ipcMain, powerMonitor, session, WebContentsView, webContents }, deckWindow });

/** Handle `channel` only for a Deck window's own page; `run` gets that window first. */
function handle(channel, run) {
  ipcMain.handle(channel, (event, ...args) => {
    const entry = deckWindow(event);
    if (!entry) throw new Error('Not the Deck window.');
    return run(entry, ...args);
  });
}

const localVoice = new VoiceRuntimeManager({
  root: path.join(app.getPath('appData'), 'dev.apexdeck.app', 'voice'),
  source: app.isPackaged ? path.join(process.resourcesPath, 'voice-sidecar') : path.join(repo, 'voice-sidecar'),
  origins: ['app://deck', 'null', ...(devUrl ? [new URL(devUrl).origin] : [])],
  progress: (value) => { for (const {win} of windows.values()) win.webContents.send('voice:progress', value); },
  log: (line) => { fs.promises.appendFile(voiceLog(), `${new Date().toISOString()} [voice helper] ${line}\n`).catch(() => {}); },
});
handle('voice:status', () => localVoice.status());
handle('voice:install', () => localVoice.install());
handle('voice:cancelInstall', () => localVoice.cancelInstall());
handle('voice:start', ({win}) => {
  const id=win.webContents.id;
  win.webContents.once('destroyed', () => void localVoice.stop(id));
  return localVoice.start(id);
});
handle('voice:warm', () => localVoice.warm().catch(() => false));
handle('voice:stop', ({win}) => localVoice.stop(win.webContents.id));
app.on('will-quit', () => void localVoice.shutdown());
// Save each "[voice end]" / "[voice event]" line from Deck windows so dropped calls can be traced.
const voiceLog = () => path.join(app.getPath('userData'), 'voice-calls.log');
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (...args) => {
    const message = String(args[0]?.message ?? args[2] ?? '');
    if (!message.startsWith('[voice end]') && !message.startsWith('[voice event]')) return;
    fs.promises.appendFile(voiceLog(), `${new Date().toISOString()} ${message}\n`).catch(() => {});
  });
});
app.whenReady().then(() => {
  powerMonitor.on('suspend', () => {
    for (const {win} of windows.values()) win.webContents.send('voice:suspend');
    void localVoice.shutdown();
  });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const entry=[...windows.values()].find(e=>e.win.webContents===contents);
    const trusted=entry && [originOf(devUrl), 'app://deck'].includes(originOf(contents.getURL()));
    const audioOnly=permission==='media' && details.mediaTypes?.includes('audio') && !details.mediaTypes?.includes('video');
    if(!trusted||!audioOnly){callback(false);return;}
    if(process.platform==='darwin') void systemPreferences.askForMediaAccess('microphone').then(callback).catch(()=>callback(false));
    else callback(true);
  });
});

handle('connection:current', async ({ host }) => {
  const remote = remoteHost(host);
  if (remote) return { id: remote.id, name: remote.name, remote: true, owned: false };
  const daemon = await ensureLocal().catch(() => null);
  return { id: LOCAL, name: LOCAL_NAME, remote: false, owned: daemon?.owned ?? true };
});

/** Settings → Remote access: the saved switch, and whether Deck can restart the daemon (so can apply a change). */
handle('remote:get', async () => {
  const daemon = await ensureLocal().catch(() => null);
  return { on: remoteAccess, owned: daemon ? restartable(daemon) : true };
});
handle('remote:set', async (_entry, on) => {
  const next = on === true;
  if (next === remoteAccess) {
    const daemon = await ensureLocal();
    return { on: remoteAccess, owned: restartable(daemon) };
  }
  // A daemon that won't start with the change gets the old setting back, saved and running.
  const daemon = await changeRemoteAccess({
    from: remoteAccess,
    to: next,
    save: (value) => saveRemoteAccess(desktopSettingsFile(), value),
    set: (value) => { remoteAccess = value; },
    restart: restartLocal,
  });
  return { on: remoteAccess, owned: restartable(daemon) };
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
/** Say hello at candidate SSH settings; nothing else runs there. */
const probeHost = ({ ssh, command }) => probeWelcome((handlers) => sshLink({ ssh, command }, handlers));
/** Edit connection's Test: which daemon answers at these settings. Saves nothing. */
handle('connection:check', async (_entry, fields) => {
  const valid = validHost({ name: 'check', ...(fields ?? {}) }, []);
  const welcome = await probeHost(valid);
  return { daemonHostId: checkWelcome(undefined, { protocol: 1, ...welcome }), version: typeof welcome?.version === 'string' ? welcome.version : null };
});
/**
 * Edit connection's Save. A new address or command is probed first, and the
 * edit is applied to the hosts saved when the probe returns, so a rename,
 * removal or second edit made meanwhile is never overwritten.
 */
handle('connection:update', async (_entry, id, fields) => {
  const host = remoteHost(id);
  if (!host) return { ok: false, reason: 'changed', words: 'There is no such server.' };
  const before = { name: host.name, ssh: host.ssh, command: host.command };
  let valid;
  try { valid = validHost(fields ?? {}, hosts.hosts.filter((h) => h.id !== id).map((h) => h.name)); }
  catch (e) { return { ok: false, reason: 'invalid', words: e.message }; }
  let probed = null;
  if (valid.ssh !== host.ssh || valid.command !== host.command) {
    try { probed = await probeHost(valid); }
    catch (e) { return { ok: false, reason: 'unreachable', words: `Couldn't reach ${valid.ssh}: ${e.message} Nothing is saved until Deck can check that it is the same machine.` }; }
  }
  try {
    const next = applyHostUpdate(hosts, id, fields, { before, probed });
    saveHosts(hostsFile(), next);
    hosts = next;
    Menu.setApplicationMenu(menu());
    return { ok: true, hosts: hostList() };
  } catch (e) {
    return { ok: false, reason: e.code ?? 'invalid', words: e.message };
  }
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
  // app.exit() skips will-quit; stop the voice helper on this path too.
  await localVoice.shutdown();
  // Sign-ins in the docked browser last: app.exit doesn't wait for Chromium to save them.
  await flushProfile();
  // The daemon Deck started ends with it; a daemon it found, or the LaunchAgent, goes on.
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
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
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
    closePopoutsOf(win.id);
    windows.delete(win.id);
    // Windows closing as the app quits stay in the list, to open next time.
    if (!gate.confirmed && windows.size > 0) {
      app.setBadgeCount([...windows.values()].reduce((sum, e) => sum + e.badge, 0));
      rememberWindows();
    }
  });
  // Unsaved edits in the file editor ask the page to stay open. Electron blocks it
  // silently unless the app answers, so ask here.
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      message: 'Discard unsaved changes?',
      detail: "A file you're editing has changes that haven't been saved.",
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice === 0) event.preventDefault();
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

/** Every pop-out window by BrowserWindow id: `{ win, browser, ownerId, token }`. Kept apart from `windows`: pop-outs never save, never count for the badge, and never ask before quitting. */
const popoutWindows = new Map();
/** What the owner handed each pop-out, by token from its `?popout=` query. */
const popoutSnapshots = new Map();

/** A pop-out token looks like 32 hex characters. */
const validToken = (token) => typeof token === 'string' && /^[0-9a-f]{32}$/.test(token);

/** Where a pop-out opens: where it was dropped, else centred on a screen the Deck window isn't on. */
function popoutBounds(ownerEntry, bounds) {
  const wanted = bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height) && bounds.width > 0 && bounds.height > 0
    ? { x: Math.round(bounds.x ?? 0), y: Math.round(bounds.y ?? 0), width: Math.round(bounds.width), height: Math.round(bounds.height) }
    : null;
  if (wanted) return wanted;
  const owner = !ownerEntry.win.isDestroyed() ? ownerEntry.win.getBounds() : null;
  const displays = screen.getAllDisplays();
  const here = owner ? screen.getDisplayMatching(owner) : screen.getPrimaryDisplay();
  const elsewhere = displays.find((d) => d.id !== here.id) ?? here;
  const width = 760;
  const height = 560;
  return {
    x: elsewhere.bounds.x + Math.max(0, Math.round((elsewhere.bounds.width - width) / 2)),
    y: elsewhere.bounds.y + Math.max(0, Math.round((elsewhere.bounds.height - height) / 2)),
    width,
    height,
  };
}

/**
 * Open one pane or side-panel tab in its own window. The owner stays the only
 * saver of layout and session; the pop-out is a view that sends actions back.
 */
function createPopout(ownerEntry, snapshot, bounds) {
  if (!snapshot || (snapshot.kind !== 'pane' && snapshot.kind !== 'tab') || typeof snapshot.id !== 'string' || typeof snapshot.title !== 'string') {
    throw new Error('That pop-out has nothing to show.');
  }
  const token = crypto.randomBytes(16).toString('hex');
  const at = popoutBounds(ownerEntry, bounds);
  const win = new BrowserWindow({
    ...at,
    minWidth: 360,
    minHeight: 240,
    title: `Deck: ${snapshot.title}`,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    show: !smoke,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.on('page-title-updated', (event) => event.preventDefault());
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
  const ownerId = ownerEntry.win.id;
  popoutWindows.set(win.id, { win, browser, ownerId, token, role: 'popout' });
  popoutSnapshots.set(token, snapshot);
  win.webContents.on('did-start-navigation', (details, _url, inPlace, mainFrame) => {
    if ((details.isMainFrame ?? mainFrame) && !(details.isSameDocument ?? inPlace)) browser.hideAll();
  });
  // A pop-out never asks before quitting; closing it returns the pane to the Deck window.
  win.on('closed', () => {
    browser.closeAll();
    popoutWindows.delete(win.id);
    popoutSnapshots.delete(token);
    const owner = windows.get(ownerId);
    if (owner && !owner.win.isDestroyed()) owner.win.webContents.send('popout:closed', token);
  });
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      message: 'Discard unsaved changes?',
      detail: "A file you're editing has changes that haven't been saved.",
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice === 0) event.preventDefault();
  });
  if (smoke) {
    win.setOpacity(0);
    win.setIgnoreMouseEvents(true);
    win.showInactive();
  }
  const query = devUrl.includes('?') ? '&' : '?';
  void win.loadURL(devUrl ? `${devUrl}${query}popout=${token}` : `app://deck/?popout=${token}`);
  return token;
}

/** Close every pop-out owned by `ownerId`. Closing the Deck window returns its panes. */
function closePopoutsOf(ownerId) {
  for (const entry of [...popoutWindows.values()]) {
    if (entry.ownerId === ownerId && !entry.win.isDestroyed()) entry.win.close();
  }
}

handle('popout:open', async (entry, snapshot, bounds) => {
  if (entry.role === 'popout') throw new Error('A pop-out cannot open another window.');
  return { token: createPopout(entry, snapshot, bounds) };
});
handle('popout:snapshot', async (_entry, token) => {
  if (!validToken(token)) throw new Error('That pop-out has nothing to show.');
  const snapshot = popoutSnapshots.get(token);
  if (!snapshot) throw new Error('That pop-out has nothing to show.');
  return snapshot;
});
handle('popout:update', async (entry, token, patch) => {
  if (!validToken(token)) return;
  const popout = [...popoutWindows.values()].find((e) => e.token === token);
  if (!popout || popout.win.isDestroyed()) return;
  if (entry.role === 'popout') return;
  popout.win.webContents.send('popout:update', patch ?? {});
});
handle('popout:action', async (entry, token, action) => {
  if (!validToken(token)) return;
  if (entry.role !== 'popout') return;
  const owner = windows.get(entry.ownerId);
  if (owner && !owner.win.isDestroyed()) owner.win.webContents.send('popout:action', token, action);
});
handle('popout:close', async (entry, token) => {
  if (!validToken(token)) return;
  // The owner closes its own pop-out (its pane is already back); a pop-out closes itself with its window.
  if (entry.role === 'popout') return;
  const popout = [...popoutWindows.values()].find((e) => e.token === token);
  if (popout && !popout.win.isDestroyed()) popout.win.close();
});

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
  remoteAccess = remoteAccessSaved(desktopSettingsFile());
  const { state, warnings } = loadHosts(hostsFile());
  hosts = state;
  warnings.forEach((warning) => console.warn(`hosts: ${warning}`));
  Menu.setApplicationMenu(menu());
  // The LaunchAgent always runs on a packaged Mac. The daemon reads whether phone connections are on.
  if (agentWanted()) ensureLocal().catch((e) => console.warn(`apex-daemon: ${e.message}`));
  // Each window a step down from the one before, so none hides another.
  const first = createWindow(LOCAL);
  rememberWindows();
  if (smoke) {
    const { runSmoke } = env.APEX_DECK_ANSWERS_SMOKE ? await import('./answers-smoke.mjs') : env.APEX_DECK_WIDGET_SMOKE ? await import('./widget-smoke.mjs') : env.APEX_DECK_MULTI_HOST_ROOT ? { runSmoke: (await import('./multi-host-smoke.mjs')).runMultiHostSmoke } : await import('./smoke.mjs');
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
