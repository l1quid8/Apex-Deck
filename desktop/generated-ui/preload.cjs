// This preload belongs only to the trusted wrapper. It deliberately exposes
// neither Deck IPC nor Node. Opaque generated subframes get no bridge.
const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) {
  const callbacks = new Set();
  ipcRenderer.on('generated-ui:command', (_event, message) => {
    for (const callback of callbacks) callback(message);
  });
  contextBridge.exposeInMainWorld('generatedUIHost', Object.freeze({
    onCommand(callback) {
      if (typeof callback !== 'function') throw new TypeError('Expected a callback.');
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    postMessage(message) {
      // Main repeats all validation. No channels, callbacks, or transferred
      // ports may be selected by the page.
      ipcRenderer.send('generated-ui:message', message);
    },
  }));
  for (const type of ['dragover', 'drop']) window.addEventListener(type, event => {
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
}
