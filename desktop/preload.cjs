// The bridge between the Deck window and Electron's main process. The window
// runs sandboxed with no Node; this is all it gets. Docked browser pages get
// no preload at all.

const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

/** Listen on `channel` until the returned function is called. */
function subscribe(channel, cb) {
  const listener = (_event, ...args) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Files dropped from Finder: taken here, where their paths can be read, and
// handed to the window with where they landed. Anything else dropped (text,
// a picture dragged from a page) goes on to the page's own handlers. A drop
// never navigates the window.
const dropped = new Set();
window.addEventListener('dragover', (event) => event.preventDefault(), true);
window.addEventListener('drop', (event) => {
  event.preventDefault();
  const paths = [...(event.dataTransfer?.files ?? [])].map((file) => webUtils.getPathForFile(file)).filter(Boolean);
  if (paths.length === 0 || dropped.size === 0) return;
  event.stopPropagation();
  // Each chat pane listens and takes the drops that land on it.
  dropped.forEach((cb) => cb(paths, event.clientX, event.clientY));
}, true);

// Once, before the page reads it: what the Tauri app (v0.4.0 and before)
// kept in its window's storage, such as installed mods. A key this app has
// already set keeps its value.
const TAURI_IMPORTED = 'apex-deck.tauri-storage-imported';
try {
  if (localStorage.getItem(TAURI_IMPORTED) === null) {
    for (const [key, value] of Object.entries(ipcRenderer.sendSync('apex:tauriStorage') ?? {})) {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    }
    localStorage.setItem(TAURI_IMPORTED, new Date().toISOString());
  }
} catch {
  // Storage unavailable: the window starts without the old values.
}

contextBridge.exposeInMainWorld('apexDeck', {
  daemon: {
    connect: (hostId) => ipcRenderer.invoke('daemon:connect', hostId),
    send: (hostId, gen, line) => ipcRenderer.send('daemon:send', hostId, gen, line),
    close: (hostId, gen) => ipcRenderer.send('daemon:close', hostId, gen),
    onLine: (cb) => subscribe('daemon:line', cb),
    onClose: (cb) => subscribe('daemon:close', cb),
  },
  connection: {
    current: () => ipcRenderer.invoke('connection:current'),
    list: () => ipcRenderer.invoke('connection:list'),
    add: (host) => ipcRenderer.invoke('connection:add', host),
    remove: (id) => ipcRenderer.invoke('connection:remove', id),
    use: (id) => ipcRenderer.invoke('connection:use', id),
    openWindow: (id) => ipcRenderer.invoke('connection:openWindow', id),
  },
  shell: {
    pickPath: (kind, title) => ipcRenderer.invoke('shell:pickPath', kind, title),
    saveFile: (name, contents) => ipcRenderer.invoke('shell:saveFile', name, contents),
    exportFile: (name, contents) => ipcRenderer.invoke('shell:exportFile', name, contents),
    exportPdf: (name, html) => ipcRenderer.invoke('shell:exportPdf', name, html),
    openArtifact: (name, contents) => ipcRenderer.invoke('shell:openArtifact', name, contents),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    setBadge: (count) => ipcRenderer.invoke('shell:setBadge', count),
    attention: (critical) => ipcRenderer.invoke('shell:attention', critical),
    startupFolders: () => ipcRenderer.invoke('shell:startupFolders'),
    readLocalFile: (path) => ipcRenderer.invoke('shell:readLocalFile', path),
    onFileDrop: (cb) => {
      dropped.add(cb);
      return () => { dropped.delete(cb); };
    },
    onQuitRequested: (cb) => subscribe('quit-requested', cb),
    quitHeard: (request) => ipcRenderer.invoke('shell:quitHeard', request),
    quitApp: () => ipcRenderer.invoke('shell:quitApp'),
    onMenu: (cb) => subscribe('menu', cb),
  },
  browser: {
    show: (pane, bounds, url) => ipcRenderer.invoke('browser:show', pane, bounds, url),
    bounds: (pane, bounds) => ipcRenderer.send('browser:bounds', pane, bounds),
    hide: (pane, snapshot) => ipcRenderer.invoke('browser:hide', pane, snapshot),
    navigate: (pane, url) => ipcRenderer.invoke('browser:navigate', pane, url),
    reload: (pane) => ipcRenderer.invoke('browser:reload', pane),
    back: (pane) => ipcRenderer.invoke('browser:back', pane),
    forward: (pane) => ipcRenderer.invoke('browser:forward', pane),
    close: (pane) => ipcRenderer.invoke('browser:close', pane),
    onState: (cb) => subscribe('browser:state', cb),
    onShortcut: (cb) => subscribe('browser:shortcut', cb),
    zoom: () => webFrame.getZoomFactor(),
  },
  smoke: ipcRenderer.sendSync('apex:smoke') === true,
});
