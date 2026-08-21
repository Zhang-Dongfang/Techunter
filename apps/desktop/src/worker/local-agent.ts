import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { minimatch } from 'minimatch';
import { readLocalTechunterConfig, type PackageFile, type Project, type Task } from '@techunter/core';
import type { LocalWorkspaceResult } from '../shared/desktop-contracts.js';

const execFileAsync = promisify(execFile);

function normalizeRelative(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized === '..' || normalized.startsWith('/') || normalized.includes('../')) throw new Error(`非法仓库路径：${value}`);
  return normalized;
}

function matches(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(file, pattern, { dot: true, nocase: process.platform === 'win32' }));
}

function credentialUrl(project: Project, accessToken?: string): string {
  const token = accessToken?.trim() || readLocalTechunterConfig().config?.githubToken?.trim();
  if (!token || project.visibility === 'public') return project.cloneUrl;
  const url = new URL(project.cloneUrl);
  url.username = 'x-access-token';
  url.password = token;
  return url.toString();
}

function safeRemote(value: string): string {
  try {
    const url = new URL(value.trim());
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value.trim();
  }
}

async function runShell(command: string, cwd: string, timeoutMs = 15 * 60_000): Promise<string> {
  const executable = process.platform === 'win32' ? 'powershell.exe' : (process.env['SHELL'] || '/bin/sh');
  const args = process.platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
    : ['-lc', command];
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: process.env, windowsHide: true, stdio: 'pipe' });
    const chunks: string[] = [];
    let size = 0;
    const append = (chunk: Buffer) => {
      if (size >= 100_000) return;
      const value = chunk.toString();
      size += value.length;
      chunks.push(value.slice(0, Math.max(0, 100_000 - size + value.length)));
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = chunks.join('').trim();
      if (code === 0) resolve(output);
      else reject(new Error(`命令失败 (${code ?? 'unknown'}): ${command}\n${output}`));
    });
  });
}

function detectedSetupCommands(root: string): string[] {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return ['corepack enable', 'pnpm install --frozen-lockfile'];
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return ['corepack enable', 'yarn install --immutable'];
  if (fs.existsSync(path.join(root, 'package-lock.json'))) return ['npm ci'];
  if (fs.existsSync(path.join(root, 'package.json'))) return ['npm install'];
  if (fs.existsSync(path.join(root, 'uv.lock'))) return ['uv sync --frozen'];
  if (fs.existsSync(path.join(root, 'requirements.txt'))) return ['python -m pip install -r requirements.txt'];
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) return ['cargo fetch'];
  if (fs.existsSync(path.join(root, 'go.mod'))) return ['go mod download'];
  return [];
}

export class LocalAgent {
  private readonly repositoriesRoot: string;
  private readonly workspacesRoot: string;
  private readonly identityPath: string;

  constructor(private readonly dataRoot: string) {
    this.repositoriesRoot = path.join(dataRoot, 'repositories');
    this.workspacesRoot = path.join(dataRoot, 'workspaces');
    this.identityPath = path.join(dataRoot, 'device.json');
  }

  async identity(): Promise<{ deviceId: string; deviceLabel: string }> {
    await fsp.mkdir(this.dataRoot, { recursive: true });
    try {
      const stored = JSON.parse(await fsp.readFile(this.identityPath, 'utf8')) as { deviceId?: string; deviceLabel?: string };
      if (stored.deviceId && stored.deviceLabel) return { deviceId: stored.deviceId, deviceLabel: stored.deviceLabel };
    } catch { /* create below */ }
    const identity = { deviceId: randomUUID(), deviceLabel: `${os.hostname()} · ${process.platform}` };
    await fsp.writeFile(this.identityPath, JSON.stringify(identity, null, 2), { mode: 0o600 });
    return identity;
  }

  async provision(project: Project, task: Task, accessToken?: string): Promise<LocalWorkspaceResult> {
    if (!task.scope) throw new Error('任务缺少 Agent 环境计划。');
    await Promise.all([fsp.mkdir(this.repositoriesRoot, { recursive: true }), fsp.mkdir(this.workspacesRoot, { recursive: true })]);
    const repositoryPath = path.join(this.repositoriesRoot, project.id);
    const workspacePath = path.join(this.workspacesRoot, task.id);
    const gitDirectory = path.join(repositoryPath, '.git');
    if (!fs.existsSync(gitDirectory)) {
      try {
        await execFileAsync('git', ['clone', '--filter=blob:none', '--no-checkout', credentialUrl(project, accessToken), repositoryPath], { timeout: 15 * 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      } finally {
        if (fs.existsSync(path.join(repositoryPath, '.git'))) {
          await execFileAsync('git', ['remote', 'set-url', 'origin', project.cloneUrl], { cwd: repositoryPath, timeout: 10_000 });
        }
      }
    } else {
      const remote = (await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: repositoryPath, timeout: 10_000 })).stdout.trim();
      const expected = `${project.repoOwner}/${project.repoName}.git`.toLowerCase();
      if (!safeRemote(remote).toLowerCase().endsWith(expected)) throw new Error(`本地项目缓存的 GitHub remote 不匹配：${safeRemote(remote)}`);
    }
    await execFileAsync('git', ['remote', 'set-url', 'origin', credentialUrl(project, accessToken)], { cwd: repositoryPath, timeout: 10_000 });
    try {
      await execFileAsync('git', ['fetch', '--prune', '--tags', 'origin'], { cwd: repositoryPath, timeout: 15 * 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    } finally {
      await execFileAsync('git', ['remote', 'set-url', 'origin', project.cloneUrl], { cwd: repositoryPath, timeout: 10_000 });
    }

    if (!fs.existsSync(workspacePath)) {
      const base = task.baseSha || `origin/${project.defaultBranch}`;
      await execFileAsync('git', ['worktree', 'add', '-B', `techunter/${task.id}`, workspacePath, base], { cwd: repositoryPath, timeout: 5 * 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    }
    const headSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspacePath, timeout: 10_000 })).stdout.trim();
    const commands = task.scope.environment.setupCommands.length
      ? task.scope.environment.setupCommands
      : detectedSetupCommands(workspacePath);
    const log: string[] = [
      `Repository: ${project.repoOwner}/${project.repoName}`,
      `Commit: ${headSha}`,
      `Environment plan: ${commands.length ? commands.join(' -> ') : 'no setup commands required'}`,
    ];
    for (const command of commands) {
      log.push(`\n> ${command}`);
      const output = await runShell(command, workspacePath);
      if (output) log.push(output);
    }
    return { taskId: task.id, path: workspacePath, headSha, setupLog: log.join('\n').slice(-100_000) };
  }

  async locate(taskId: string): Promise<{ path: string | null }> {
    const candidate = path.join(this.workspacesRoot, taskId);
    return { path: fs.existsSync(candidate) ? candidate : null };
  }

  async collectChanges(task: Task): Promise<{ path: string; files: PackageFile[] }> {
    if (!task.scope) throw new Error('任务缺少文件范围。');
    const workspacePath = path.join(this.workspacesRoot, task.id);
    if (!fs.existsSync(workspacePath)) throw new Error('本机没有这个任务的工作环境。');
    const base = task.baseSha || 'HEAD';
    const [tracked, untracked] = await Promise.all([
      execFileAsync('git', ['diff', '--no-renames', '--name-only', '-z', base, '--'], { cwd: workspacePath, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
      execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: workspacePath, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
    ]);
    const changed = [...new Set(`${tracked.stdout}\0${untracked.stdout}`.split('\0').map((file) => file.trim()).filter(Boolean).map(normalizeRelative))];
    for (const file of changed) {
      if (!matches(file, task.scope.editablePaths) || matches(file, task.scope.deniedPaths)) throw new Error(`本机改动超出任务 editablePaths：${file}`);
    }
    const files: PackageFile[] = [];
    let totalBytes = 0;
    for (const relative of changed) {
      const absolute = path.resolve(workspacePath, relative);
      if (!absolute.startsWith(`${path.resolve(workspacePath)}${path.sep}`)) throw new Error(`文件越出工作区：${relative}`);
      let data: Buffer;
      try { data = await fsp.readFile(absolute); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { files.push({ path: relative, content: null, encoding: 'utf-8' }); continue; }
        throw error;
      }
      totalBytes += data.length;
      if (data.length > 2 * 1024 * 1024 || totalBytes > 15 * 1024 * 1024) throw new Error('提交文件超过大小限制。');
      const binary = data.includes(0);
      files.push({ path: relative, content: binary ? data.toString('base64') : data.toString('utf8'), encoding: binary ? 'base64' : 'utf-8' });
    }
    return { path: workspacePath, files };
  }
}
