// The bridge between the Deck window and Electron's main process. The window
// runs sandboxed with no Node; this is all it gets. Docked browser pages get
// no preload at all.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apexDeck', {
  daemon: {
    connect: () => ipcRenderer.invoke('daemon:connect'),
    send: (gen, line) => ipcRenderer.send('daemon:send', gen, line),
    close: (gen) => ipcRenderer.send('daemon:close', gen),
    onLine: (cb) => { ipcRenderer.on('daemon:line', (_event, gen, line) => cb(gen, line)); },
    onClose: (cb) => { ipcRenderer.on('daemon:close', (_event, gen, reason) => cb(gen, reason)); },
  },
  connection: {
    current: () => ipcRenderer.invoke('connection:current'),
  },
  smoke: ipcRenderer.sendSync('apex:smoke') === true,
});
