import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { LocalAgent } from '../worker/local-agent';
import { authorizeConexusInBrowser, type ConexusBrowserAuthInput } from './browser-auth';
import { registerAutoUpdates } from './updates';

try {
  const envPath = app.isPackaged
    ? path.join(process.resourcesPath, '.env')
    : path.resolve(process.cwd(), '.env');
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
let localUiServer: Server | undefined;
let rendererOrigin = '';

const configuredApiUrl = (process.env['TECHUNTER_API_URL'] || 'http://127.0.0.1:4310').replace(/\/+$/, '');
const configuredRendererUrl = process.env['TECHUNTER_RENDERER_URL']?.replace(/\/+$/, '');
const configuredUiPort = Number(process.env['TECHUNTER_UI_PORT'] ?? '4311');
const configuredZoom = Number(process.env['TECHUNTER_DESKTOP_ZOOM'] ?? '1.25');
const defaultZoom = Number.isFinite(configuredZoom) ? Math.min(1.6, Math.max(0.8, configuredZoom)) : 1.25;
const autoUpdates = registerAutoUpdates({
  assertTrustedSender,
  getWindow: () => mainWindow,
});

function allowedRendererUrl(rawUrl: string): boolean {
  try {
    return Boolean(rendererOrigin) && new URL(rawUrl).origin === rendererOrigin;
  } catch {
    return false;
  }
}

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function startBundledUi(): Promise<string> {
  if (localUiServer?.listening) return Promise.resolve(`http://127.0.0.1:${configuredUiPort}`);
  const root = path.resolve(__dirname, '../web');
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`未找到 Desktop UI 构建产物：${root}。请先运行 npm run build:web。`);
  }
  if (!Number.isInteger(configuredUiPort) || configuredUiPort < 1 || configuredUiPort > 65_535) {
    throw new Error('TECHUNTER_UI_PORT 必须是有效端口。');
  }

  localUiServer = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', `http://127.0.0.1:${configuredUiPort}`).pathname);
      const requestedPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = path.resolve(root, requestedPath);
      const relativePath = path.relative(root, filePath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        response.writeHead(403).end();
        return;
      }
      const stat = fs.statSync(filePath, { throwIfNoEntry: false });
      if (!stat?.isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      if (request.method === 'HEAD') response.end();
      else fs.createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(400).end();
    }
  });

  return new Promise((resolve, reject) => {
    localUiServer?.once('error', reject);
    localUiServer?.listen(configuredUiPort, '127.0.0.1', () => {
      localUiServer?.removeListener('error', reject);
      resolve(`http://127.0.0.1:${configuredUiPort}`);
    });
  });
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
  ipcMain.handle('project:sync', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (!input || typeof input !== 'object' || !(input as { project?: unknown }).project) throw new Error('项目参数无效。');
    const options: Electron.OpenDialogOptions = {
      title: '选择项目存放目录',
      buttonLabel: '同步到这里',
      properties: ['openDirectory', 'createDirectory'],
    };
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (selection.canceled || !selection.filePaths[0]) return null;
    const value = input as { project: Parameters<LocalAgent['syncProject']>[0]; accessToken?: unknown };
    return localAgent.syncProject(value.project, selection.filePaths[0], typeof value.accessToken === 'string' ? value.accessToken : undefined);
  });
  ipcMain.handle('project:locate', (event, projectId: unknown) => {
    assertTrustedSender(event);
    if (typeof projectId !== 'string') throw new Error('项目 ID 无效。');
    return localAgent.locateProject(projectId);
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
  ipcMain.handle('agent:test', (event, input: unknown) => {
    assertTrustedSender(event);
    if (!input || typeof input !== 'object' || !(input as { task?: unknown }).task) throw new Error('任务参数无效。');
    return localAgent.test((input as { task: Parameters<LocalAgent['test']>[0] }).task);
  });
}

function registerAuthenticationIpc(): void {
  ipcMain.handle('auth:conexus', (event, rawInput: unknown) => {
    assertTrustedSender(event);
    if (!rawInput || typeof rawInput !== 'object') throw new Error('Conexus 浏览器登录参数无效。');
    const input = rawInput as Record<string, unknown>;
    if (
      typeof input['apiUrl'] !== 'string' || typeof input['publicationSlug'] !== 'string' ||
      typeof input['displayName'] !== 'string'
    ) throw new Error('Conexus 浏览器登录参数无效。');
    return authorizeConexusInBrowser(input as unknown as ConexusBrowserAuthInput, rendererOrigin, (url) => shell.openExternal(url));
  });
  ipcMain.handle('auth:open-url', async (event, rawUrl: unknown) => {
    assertTrustedSender(event);
    if (typeof rawUrl !== 'string') throw new Error('浏览器授权地址无效。');
    const url = new URL(rawUrl);
    if (url.origin !== 'https://github.com' || url.pathname !== '/login/oauth/authorize') {
      throw new Error('拒绝打开非 GitHub OAuth 地址。');
    }
    await shell.openExternal(url.toString());
  });
}

async function createWindow(): Promise<void> {
  const rendererUrl = configuredRendererUrl || await startBundledUi();
  rendererOrigin = new URL(rendererUrl).origin;
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

  await mainWindow.loadURL(rendererUrl);
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
    registerAuthenticationIpc();
    autoUpdates.start();
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
  autoUpdates.stop();
  for (const session of terminalSessions.values()) session.process.kill();
  terminalSessions.clear();
  localUiServer?.close();
  localUiServer = undefined;
});
