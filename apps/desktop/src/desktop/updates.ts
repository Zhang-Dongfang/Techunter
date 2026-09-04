import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { autoUpdater } from 'electron-updater';

import type { DesktopUpdateState } from '../shared/desktop-contracts';

const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1_000;
const INITIAL_UPDATE_DELAY_MS = 10_000;

type AutoUpdateOptions = {
  assertTrustedSender(event: IpcMainInvokeEvent): void;
  getWindow(): BrowserWindow | undefined;
};

export type AutoUpdateController = {
  start(): void;
  stop(): void;
};

export function registerAutoUpdates(options: AutoUpdateOptions): AutoUpdateController {
  let state: DesktopUpdateState = {
    status: app.isPackaged ? 'idle' : 'disabled',
    currentVersion: app.getVersion(),
    message: app.isPackaged ? undefined : '开发模式下不检查更新',
  };
  let initialTimer: NodeJS.Timeout | undefined;
  let intervalTimer: NodeJS.Timeout | undefined;
  let started = false;

  function publish(nextState: DesktopUpdateState): void {
    state = nextState;
    const window = options.getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('update:state-changed', state);
  }

  async function check(): Promise<DesktopUpdateState> {
    if (!app.isPackaged) return state;
    if (['checking', 'available', 'downloading', 'downloaded'].includes(state.status)) return state;
    try {
      await autoUpdater.checkForUpdates();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (state.status !== 'error') publish({ ...state, status: 'error', message });
    }
    return state;
  }

  ipcMain.handle('update:state', (event) => {
    options.assertTrustedSender(event);
    return state;
  });
  ipcMain.handle('update:check', (event) => {
    options.assertTrustedSender(event);
    return check();
  });
  ipcMain.handle('update:install', (event) => {
    options.assertTrustedSender(event);
    if (state.status !== 'downloaded') throw new Error('更新尚未下载完成。');
    autoUpdater.quitAndInstall(false, true);
  });

  return {
    start() {
      if (started || !app.isPackaged) return;
      started = true;
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.autoRunAppAfterInstall = true;
      autoUpdater.allowPrerelease = false;

      autoUpdater.on('checking-for-update', () => {
        publish({ status: 'checking', currentVersion: app.getVersion() });
      });
      autoUpdater.on('update-available', (info) => {
        publish({
          status: 'available',
          currentVersion: app.getVersion(),
          availableVersion: info.version,
          message: '发现新版本，正在准备下载',
        });
      });
      autoUpdater.on('download-progress', (progress) => {
        publish({
          status: 'downloading',
          currentVersion: app.getVersion(),
          availableVersion: state.availableVersion,
          progress: Math.max(0, Math.min(100, Math.round(progress.percent))),
        });
      });
      autoUpdater.on('update-downloaded', (info) => {
        publish({
          status: 'downloaded',
          currentVersion: app.getVersion(),
          availableVersion: info.version,
          progress: 100,
          message: '更新已下载，将在退出后自动安装',
        });
      });
      autoUpdater.on('update-not-available', () => {
        publish({ status: 'up-to-date', currentVersion: app.getVersion(), message: '已是最新版本' });
      });
      autoUpdater.on('error', (error) => {
        publish({
          status: 'error',
          currentVersion: app.getVersion(),
          availableVersion: state.availableVersion,
          message: error.message,
        });
      });

      initialTimer = setTimeout(() => { void check(); }, INITIAL_UPDATE_DELAY_MS);
      initialTimer.unref();
      intervalTimer = setInterval(() => { void check(); }, UPDATE_INTERVAL_MS);
      intervalTimer.unref();
    },
    stop() {
      if (initialTimer) clearTimeout(initialTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      initialTimer = undefined;
      intervalTimer = undefined;
    },
  };
}
