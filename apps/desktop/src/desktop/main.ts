import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { DEFAULT_CONEXUS_API_URL } from '@techunter/core';
import { LocalAgent } from '../worker/local-agent';

try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
} catch {
  // Process-level environment values remain authoritative.
}

type TerminalSession = {
  process: ChildProcessWithoutNullStreams;
  owner: Electron.WebContents;
};

const terminalSessions = new Map<string, TerminalSession>();
let mainWindow: BrowserWindow | undefined;

const configuredWebUrl = process.env['TECHUNTER_WEB_URL'] || process.env['TECHUNTER_API_URL'];
const configuredZoom = Number(process.env['TECHUNTER_DESKTOP_ZOOM'] ?? '1.15');
const defaultZoom = Number.isFinite(configuredZoom) ? Math.min(1.6, Math.max(0.8, configuredZoom)) : 1.15;

function allowedRendererUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (!configuredWebUrl) return false;
    const allowed = new URL(configuredWebUrl);
    return url.origin === allowed.origin;
  } catch {
    return false;
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
  if (!allowedRendererUrl(senderUrl)) throw new Error('拒绝来自非 Techunter 页面的方法调用。');
}

function resolveWorkingDirectory(candidate?: string): string {
  const cwd = path.resolve(candidate?.trim() || app.getPath('home'));
  const stat = fs.statSync(cwd, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error(`工作目录不存在：${cwd}`);
  return cwd;
}

function shellInvocation(command: string): { executable: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      executable: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    };
  }
  return {
    executable: process.env['SHELL'] || '/bin/sh',
    args: ['-lc', command],
  };
}

function registerTerminalIpc(): void {
  ipcMain.handle('terminal:run', (event, rawInput: unknown) => {
    assertTrustedSender(event);
    if (!rawInput || typeof rawInput !== 'object') throw new Error('命令参数无效。');

    const input = rawInput as { command?: unknown; cwd?: unknown };
    if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('命令不能为空。');
    if (input.cwd !== undefined && typeof input.cwd !== 'string') throw new Error('工作目录无效。');

    const cwd = resolveWorkingDirectory(input.cwd);
    const invocation = shellInvocation(input.command);
    const sessionId = randomUUID();
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: 'pipe',
    });

    terminalSessions.set(sessionId, { process: child, owner: event.sender });
    child.stdout.on('data', (chunk: Buffer) => {
      if (!event.sender.isDestroyed()) event.sender.send('terminal:output', { sessionId, stream: 'stdout', data: chunk.toString() });
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (!event.sender.isDestroyed()) event.sender.send('terminal:output', { sessionId, stream: 'stderr', data: chunk.toString() });
    });
    child.on('error', (error) => {
      if (!event.sender.isDestroyed()) event.sender.send('terminal:output', { sessionId, stream: 'stderr', data: `${error.message}\n` });
    });
    child.on('close', (exitCode) => {
      terminalSessions.delete(sessionId);
      if (!event.sender.isDestroyed()) event.sender.send('terminal:exit', { sessionId, exitCode });
    });

    return { sessionId };
  });

  ipcMain.handle('terminal:cancel', (event, sessionId: unknown) => {
    assertTrustedSender(event);
    if (typeof sessionId !== 'string') return;
    const session = terminalSessions.get(sessionId);
    if (session?.owner === event.sender) session.process.kill();
  });
}

function registerLocalAgentIpc(): void {
  const localAgent = new LocalAgent(path.join(app.getPath('userData'), 'agent'));
  ipcMain.handle('agent:identity', (event) => {
    assertTrustedSender(event);
    return localAgent.identity();
  });
  ipcMain.handle('agent:provision', (event, input: unknown) => {
    assertTrustedSender(event);
    if (!input || typeof input !== 'object') throw new Error('环境参数无效。');
    const value = input as { project?: unknown; task?: unknown };
    if (!value.project || !value.task) throw new Error('项目或任务参数缺失。');
    return localAgent.provision(
      value.project as Parameters<LocalAgent['provision']>[0],
      value.task as Parameters<LocalAgent['provision']>[1],
      typeof (value as { accessToken?: unknown }).accessToken === 'string' ? (value as { accessToken: string }).accessToken : undefined,
    );
  });
  ipcMain.handle('agent:locate', (event, taskId: unknown) => {
    assertTrustedSender(event);
    if (typeof taskId !== 'string') throw new Error('任务 ID 无效。');
    return localAgent.locate(taskId);
  });
  ipcMain.handle('agent:collect-changes', (event, input: unknown) => {
    assertTrustedSender(event);
    if (!input || typeof input !== 'object' || !(input as { task?: unknown }).task) throw new Error('任务参数无效。');
    return localAgent.collectChanges((input as { task: Parameters<LocalAgent['collectChanges']>[0] }).task);
  });
}

async function createWindow(): Promise<void> {
  const preloadPath = path.join(__dirname, 'preload.cjs');
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#090b0d',
    show: false,
    autoHideMenuBar: true,
    title: 'Techunter · 科技猎人',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      zoomFactor: defaultZoom,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!input.control && !input.meta) return;
    const current = mainWindow?.webContents.getZoomFactor() ?? defaultZoom;
    if (input.key === '+' || input.key === '=') {
      mainWindow?.webContents.setZoomFactor(Math.min(1.6, Math.round((current + 0.1) * 10) / 10));
      event.preventDefault();
    } else if (input.key === '-') {
      mainWindow?.webContents.setZoomFactor(Math.max(0.8, Math.round((current - 0.1) * 10) / 10));
      event.preventDefault();
    } else if (input.key === '0') {
      mainWindow?.webContents.setZoomFactor(defaultZoom);
      event.preventDefault();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      const conexusOrigin = new URL(process.env['CONEXUS_API_URL'] ?? DEFAULT_CONEXUS_API_URL).origin;
      if (target.origin === conexusOrigin && target.pathname === '/v1/auth/web') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 480,
            height: 720,
            autoHideMenuBar: true,
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
            },
          },
        };
      }
    } catch {
      // Non-URL targets are denied below.
    }
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!allowedRendererUrl(url)) event.preventDefault();
  });

  if (!configuredWebUrl) throw new Error('未配置 TECHUNTER_WEB_URL（中央 Techunter API/Web 地址）。');
  await mainWindow.loadURL(configuredWebUrl);
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });

  app.whenReady().then(async () => {
    registerTerminalIpc();
    registerLocalAgentIpc();
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    app.quit();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const session of terminalSessions.values()) session.process.kill();
  terminalSessions.clear();
});
