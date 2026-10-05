// The bridge between the Deck window and Electron's main process. The window
// runs sandboxed with no Node; this is all it gets. Docked browser pages get
// no preload at all.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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

contextBridge.exposeInMainWorld('apexDeck', {
  daemon: {
    connect: () => ipcRenderer.invoke('daemon:connect'),
    send: (gen, line) => ipcRenderer.send('daemon:send', gen, line),
    close: (gen) => ipcRenderer.send('daemon:close', gen),
    onLine: (cb) => { subscribe('daemon:line', cb); },
    onClose: (cb) => { subscribe('daemon:close', cb); },
  },
  connection: {
    current: () => ipcRenderer.invoke('connection:current'),
    list: () => ipcRenderer.invoke('connection:list'),
    add: (host) => ipcRenderer.invoke('connection:add', host),
    remove: (id) => ipcRenderer.invoke('connection:remove', id),
    use: (id) => ipcRenderer.invoke('connection:use', id),
  },
  shell: {
    pickPath: (kind, title) => ipcRenderer.invoke('shell:pickPath', kind, title),
    saveFile: (name, contents) => ipcRenderer.invoke('shell:saveFile', name, contents),
    exportFile: (name, contents) => ipcRenderer.invoke('shell:exportFile', name, contents),
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
  smoke: ipcRenderer.sendSync('apex:smoke') === true,
});
