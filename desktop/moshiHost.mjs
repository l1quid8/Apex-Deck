import path from 'node:path';
import fs from 'node:fs/promises';
import { moshiRuntime } from './moshiRuntime.mjs';
import { voiceRequestAllowed } from './moshi.mjs';

/** This window gets no preload, daemon connection, tools or API keys. */
export function installMoshi({ app, ipcMain, BrowserWindow, session, dialog, deckWindow, root }) {
  const runtime = moshiRuntime(root);
  let owner = null, window = null, opening = null, stopping = null, generation = 0;
  function stop() {
    if (stopping) return stopping;
    generation++;
    const old = window; window = null;
    old?.destroy();
    stopping = runtime.stop().finally(() => { owner = null; stopping = null; });
    return stopping;
  }
  function trusted(event) {
    const entry = deckWindow(event);
    if (!entry) throw new Error('Not the Deck window.');
    if (owner && owner !== event.sender) throw new Error('Local voice is in use in another Deck window.');
    return entry;
  }
  ipcMain.handle('moshi:status', event => { trusted(event); return runtime.status(); });
  ipcMain.handle('moshi:stop', async event => { trusted(event); await stop(); });
  const open = async (event) => {
    await stopping;
    const entry = trusted(event);
    if (window && runtime.status().phase === 'error') { await stop(); return open(event); }
    if (window) { window.show(); window.focus(); return; }
    if (opening) return opening;
    owner = event.sender;
    const mine = ++generation;
    opening = (async () => {
      if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Local Moshi requires an Apple Silicon Mac.');
      const installed = await fs.access(path.join(root, 'installed-v1')).then(() => true, () => false);
      if (!installed) {
        const result = await dialog.showMessageBox(entry.win, { type: 'question', title: 'Set up local voice?',
          message: 'Download Moshi to this Mac?', detail: 'Approximately 5.2 GB of model files, plus a private voice runtime. Setup runs automatically and files are kept for future calls. Audio is processed on this Mac. Experimental; Apple Silicon required.',
          buttons: ['Download and start', 'Cancel'], defaultId: 0, cancelId: 1 });
        if (result.response !== 0) return;
      }
      if (mine !== generation) return;
      const result = await runtime.start(true);
      if (mine !== generation || event.sender.isDestroyed()) { await runtime.stop(); return; }
      const ses = session.fromPartition(`moshi-${result.token}`);
      // Even a local web page cannot connect without this private session header.
      ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !voiceRequestAllowed(details.url, result.url) }));
      ses.webRequest.onBeforeSendHeaders((details, cb) => {
        if (!voiceRequestAllowed(details.url, result.url)) { cb({ cancel: true }); return; }
        cb({ requestHeaders: { ...details.requestHeaders, 'X-Apex-Voice-Token': result.token } });
      });
      const allowedMedia = (contents, permission, details) => window && contents === window.webContents && permission === 'media'
        && voiceRequestAllowed(details.securityOrigin ?? details.requestingUrl ?? '', result.url)
        && details.mediaTypes?.length > 0 && details.mediaTypes.every(kind => kind === 'audio');
      ses.setPermissionRequestHandler((contents, permission, cb, details) => cb(Boolean(allowedMedia(contents, permission, details))));
      ses.setPermissionCheckHandler((contents, permission, origin, details) => Boolean(window && contents === window.webContents
        && permission === 'media' && details.mediaType === 'audio' && voiceRequestAllowed(origin, result.url)));
      window = new BrowserWindow({ width: 680, height: 760, title: 'Local voice · Apex Deck', autoHideMenuBar: true,
        webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true,
          autoplayPolicy: 'no-user-gesture-required', webSecurity: true } });
      const voiceWindow = window;
      voiceWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      voiceWindow.webContents.on('will-navigate', (ev, url) => {
        ev.preventDefault();
        // A fixed, user-clicked local route restarts the whole session. The
        // voice page never receives a Deck preload or a general IPC bridge.
        if (url === `${result.url}/restart`) void stop().then(() => open(event)).catch(() => {});
      });
      voiceWindow.webContents.on('will-attach-webview', ev => ev.preventDefault());
      voiceWindow.on('closed', () => { if (window === voiceWindow) void stop(); });
      try { await voiceWindow.loadURL(result.url); }
      catch (error) { await stop(); throw error; }
    })().catch(async error => { await stop(); throw error; }).finally(() => { opening = null; if (!window) owner = null; });
    return opening;
  };
  ipcMain.handle('moshi:open', open);
  // App/window shutdown must release the microphone and the entire process group.
  app.on('web-contents-created', (_event, contents) => contents.once('destroyed', () => { if (owner === contents) void stop(); }));
  app.on('will-quit', () => { void stop(); });
  return { stop };
}
