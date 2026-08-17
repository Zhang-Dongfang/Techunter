import { contextBridge, ipcRenderer } from 'electron';

import type { DesktopTerminalApi } from '../shared/contracts';

const terminalApi: DesktopTerminalApi = {
  platform: process.platform,
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

contextBridge.exposeInMainWorld('techunterDesktop', Object.freeze(terminalApi));
