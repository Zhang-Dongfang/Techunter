import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';

type TerminalSession = {
  process: ChildProcessWithoutNullStreams;
  owner: Electron.WebContents;
};

const terminalSessions = new Map<string, TerminalSession>();
let apiProcess: ChildProcess | undefined;
let mainWindow: BrowserWindow | undefined;

const developmentUrl = process.env['TECHUNTER_WEB_URL'];
const productionUrl = `http://127.0.0.1:${process.env['TECHUNTER_PORT'] ?? '4310'}`;
const configuredZoom = Number(process.env['TECHUNTER_DESKTOP_ZOOM'] ?? '1.15');
const defaultZoom = Number.isFinite(configuredZoom) ? Math.min(1.6, Math.max(0.8, configuredZoom)) : 1.15;

function allowedRendererUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const allowed = new URL(developmentUrl ?? productionUrl);
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

async function waitForApi(url: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The local server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Techunter 本地服务启动超时。');
}

async function ensureProductionApi(): Promise<string> {
  if (developmentUrl) return developmentUrl;

  const applicationRoot = app.getAppPath();
  const serverEntry = path.join(applicationRoot, 'dist', 'server', 'index.mjs');
  if (!fs.existsSync(serverEntry)) throw new Error(`找不到服务端构建产物：${serverEntry}`);

  apiProcess = spawn(process.execPath, [serverEntry], {
    cwd: applicationRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TECHUNTER_HOST: '127.0.0.1',
      TECHUNTER_PORT: process.env['TECHUNTER_PORT'] ?? '4310',
      TECHUNTER_PUBLIC_URL: productionUrl,
      TECHUNTER_WEB_URL: productionUrl,
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  apiProcess.once('exit', (code) => {
    if (code) console.error(`Techunter API exited with code ${code}`);
  });
  await waitForApi(productionUrl);
  return productionUrl;
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
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!allowedRendererUrl(url)) event.preventDefault();
  });

  const pageUrl = await ensureProductionApi();
  await mainWindow.loadURL(pageUrl);
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
  apiProcess?.kill();
});
