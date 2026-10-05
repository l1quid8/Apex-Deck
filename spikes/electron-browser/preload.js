const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('agent', (op, ...args) => ipcRenderer.invoke('agent', op, ...args));
