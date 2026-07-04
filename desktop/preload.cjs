// Preload bridge (runs in the isolated, sandboxed world of the window). It's the
// ONLY channel between the web UI (served over http://127.0.0.1:8787) and the
// Electron main process. We expose a tiny, explicit `window.prismaxim.updates`
// surface — used by the Settings "Update" button (see web/lib/desktop.ts). CJS
// on purpose: sandboxed preloads may only require('electron').
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prismaxim', {
  updates: {
    // Current running version (from the packaged app's package.json).
    getVersion: () => ipcRenderer.invoke('updates:getVersion'),
    // Ask GitHub whether a newer release exists. Drives the 'updates:event' stream.
    check: () => ipcRenderer.invoke('updates:check'),
    // Download the pending update in the background (progress via 'updates:event').
    download: () => ipcRenderer.invoke('updates:download'),
    // Quit and run the downloaded installer.
    install: () => ipcRenderer.invoke('updates:install'),
    // Subscribe to update lifecycle events; returns an unsubscribe function.
    onEvent: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('updates:event', listener);
      return () => ipcRenderer.removeListener('updates:event', listener);
    },
  },
});
