import type { IpcRendererEvent } from 'electron';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld('photohost', {
  getState: () => ipcRenderer.invoke('state:get'),
  chooseDirectory: () => ipcRenderer.invoke('directory:choose'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('config:save', config),
  testLlm: (config: unknown) => ipcRenderer.invoke('llm:test', config),
  backfillMetadata: (config: unknown) => ipcRenderer.invoke('metadata:backfill', config),
  syncMissing: () => ipcRenderer.invoke('sync:missing'),
  setAutoStart: (enabled: boolean) => ipcRenderer.invoke('startup:set', enabled),
  startDaemon: () => ipcRenderer.invoke('daemon:start'),
  stopDaemon: () => ipcRenderer.invoke('daemon:stop'),
  restartDaemon: () => ipcRenderer.invoke('daemon:restart'),
  openExternal: (url: string) => ipcRenderer.invoke('open:external', url),
  openPath: (path: string) => ipcRenderer.invoke('open:path', path),
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on('state:update', listener);
    return () => ipcRenderer.off('state:update', listener);
  }
});
