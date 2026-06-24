const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('photohost', {
  getState: () => ipcRenderer.invoke('state:get'),
  chooseDirectory: () => ipcRenderer.invoke('directory:choose'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  testLlm: (config) => ipcRenderer.invoke('llm:test', config),
  backfillMetadata: (config) => ipcRenderer.invoke('metadata:backfill', config),
  syncMissing: () => ipcRenderer.invoke('sync:missing'),
  setAutoStart: (enabled) => ipcRenderer.invoke('startup:set', enabled),
  startDaemon: () => ipcRenderer.invoke('daemon:start'),
  stopDaemon: () => ipcRenderer.invoke('daemon:stop'),
  restartDaemon: () => ipcRenderer.invoke('daemon:restart'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  openPath: (targetPath) => ipcRenderer.invoke('open:path', targetPath),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state:update', listener);
    return () => ipcRenderer.off('state:update', listener);
  }
});
