import { contextBridge, ipcRenderer } from 'electron';

import type { DesktopAgentApi } from '../shared/desktop-contracts';

const desktopApi: DesktopAgentApi = {
  apiBaseUrl: process.env['TECHUNTER_API_URL']?.replace(/\/+$/, '') || 'http://127.0.0.1:4310',
  platform: process.platform,
  identity() {
    return ipcRenderer.invoke('agent:identity');
  },
  provision(input) {
    return ipcRenderer.invoke('agent:provision', input);
  },
  locate(taskId) {
    return ipcRenderer.invoke('agent:locate', taskId);
  },
  collectChanges(input) {
    return ipcRenderer.invoke('agent:collect-changes', input);
  },
  run(input) {
    return ipcRenderer.invoke('terminal:run', input);
  },
  cancel(sessionId) {
    return ipcRenderer.invoke('terminal:cancel', sessionId);
  },
  onOutput(listener) {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload);
    ipcRenderer.on('terminal:output', handler);
    return () => ipcRenderer.removeListener('terminal:output', handler);
  },
  onExit(listener) {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload);
    ipcRenderer.on('terminal:exit', handler);
    return () => ipcRenderer.removeListener('terminal:exit', handler);
  },
};

contextBridge.exposeInMainWorld('techunterDesktop', Object.freeze(desktopApi));
