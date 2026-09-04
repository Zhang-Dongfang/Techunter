import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { minimatch } from 'minimatch';
import { readLocalTechunterConfig, type PackageFile, type Project, type Task } from '@techunter/core';
import type { LocalProjectSyncResult, LocalWorkspaceResult } from '../shared/desktop-contracts.js';

const execFileAsync = promisify(execFile);

function normalizeRelative(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized === '..' || normalized.startsWith('/') || normalized.includes('../')) throw new Error(`非法仓库路径：${value}`);
  return normalized;
}

function matches(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(file, pattern, { dot: true, nocase: process.platform === 'win32' }));
}

function gitEnvironment(project: Project, accessToken?: string): NodeJS.ProcessEnv {
  const token = accessToken?.trim() || readLocalTechunterConfig().config?.githubToken?.trim();
  if (!token || project.visibility === 'public') return process.env;
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
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

function remoteMatchesProject(remote: string, project: Project): boolean {
  const normalize = (value: string) => safeRemote(value).replaceAll('\\', '/').replace(/\/$/, '').replace(/\.git$/i, '').toLowerCase();
  const actual = normalize(remote);
  const expected = normalize(project.cloneUrl);
  if (actual === expected) return true;
  const githubPath = `${project.repoOwner}/${project.repoName}`.toLowerCase();
  return actual.endsWith(`/${githubPath}`) || actual.endsWith(`:${githubPath}`);
}

type ProjectLocations = { version: 1; projects: Record<string, string> };

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
  private readonly workspacesRoot: string;
  private readonly identityPath: string;
  private readonly projectLocationsPath: string;

  constructor(private readonly dataRoot: string) {
    this.workspacesRoot = path.join(dataRoot, 'workspaces');
    this.identityPath = path.join(dataRoot, 'device.json');
    this.projectLocationsPath = path.join(dataRoot, 'projects.json');
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

  async syncProject(project: Project, parentDirectory: string, accessToken?: string): Promise<LocalProjectSyncResult> {
    if (!path.isAbsolute(parentDirectory)) throw new Error('项目存放目录必须是绝对路径。');
    if (!/^[A-Za-z0-9_.-]+$/.test(project.repoName)) throw new Error('GitHub 仓库名称不能作为本地目录。');
    const parentPath = path.resolve(parentDirectory);
    await fsp.mkdir(parentPath, { recursive: true });
    const repositoryPath = path.join(parentPath, project.repoName);
    let outcome: LocalProjectSyncResult['outcome'] = 'cloned';

    if (await this.isGitRepository(repositoryPath)) {
      await this.assertProjectRemote(repositoryPath, project);
      outcome = await this.fetchProject(repositoryPath, project, accessToken, true);
    } else {
      if (fs.existsSync(repositoryPath) && (await fsp.readdir(repositoryPath)).length > 0) {
        throw new Error(`目标目录已存在且不是 Git 仓库：${repositoryPath}`);
      }
      await execFileAsync('git', ['clone', '--filter=blob:none', project.cloneUrl, repositoryPath], {
        env: gitEnvironment(project, accessToken),
        timeout: 15 * 60_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
    }

    const status = (await execFileAsync('git', ['status', '--porcelain'], { cwd: repositoryPath, timeout: 30_000 })).stdout;
    const headSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryPath, timeout: 10_000 })).stdout.trim();
    await this.saveProjectLocation(project.id, repositoryPath);
    return { projectId: project.id, path: repositoryPath, headSha, outcome, workingTreeClean: status.trim().length === 0 };
  }

  async locateProject(projectId: string): Promise<{ path: string | null }> {
    const projectPath = (await this.projectLocations()).projects[projectId];
    return { path: projectPath && await this.isGitRepository(projectPath) ? projectPath : null };
  }

  async provision(project: Project, task: Task, accessToken?: string): Promise<LocalWorkspaceResult> {
    if (!task.scope) throw new Error('任务缺少 Agent 环境计划。');
    await fsp.mkdir(this.workspacesRoot, { recursive: true });
    const repositoryPath = (await this.locateProject(project.id)).path;
    if (!repositoryPath) throw new Error('请先在项目页面选择目录并同步仓库。');
    const workspacePath = path.join(this.workspacesRoot, task.id);
    await this.assertProjectRemote(repositoryPath, project);
    await this.fetchProject(repositoryPath, project, accessToken, false);

    if (!fs.existsSync(workspacePath)) {
      const base = task.baseSha || `origin/${project.sourceBranch || project.defaultBranch}`;
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

  private async projectLocations(): Promise<ProjectLocations> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.projectLocationsPath, 'utf8')) as Partial<ProjectLocations>;
      if (parsed.version === 1 && parsed.projects && typeof parsed.projects === 'object') {
        return { version: 1, projects: Object.fromEntries(Object.entries(parsed.projects).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) };
      }
    } catch { /* no saved project locations yet */ }
    return { version: 1, projects: {} };
  }

  private async saveProjectLocation(projectId: string, repositoryPath: string): Promise<void> {
    await fsp.mkdir(this.dataRoot, { recursive: true });
    const locations = await this.projectLocations();
    locations.projects[projectId] = repositoryPath;
    await fsp.writeFile(this.projectLocationsPath, JSON.stringify(locations, null, 2), { mode: 0o600 });
  }

  private async isGitRepository(repositoryPath: string): Promise<boolean> {
    if (!fs.existsSync(repositoryPath)) return false;
    try {
      const result = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repositoryPath, timeout: 10_000 });
      return result.stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  private async assertProjectRemote(repositoryPath: string, project: Project): Promise<void> {
    const remote = (await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: repositoryPath, timeout: 10_000 })).stdout.trim();
    if (!remoteMatchesProject(remote, project)) throw new Error(`本地目录的 GitHub remote 不匹配：${safeRemote(remote)}`);
  }

  private async fetchProject(repositoryPath: string, project: Project, accessToken: string | undefined, updateWorkingTree: boolean): Promise<'updated' | 'fetched'> {
    await execFileAsync('git', ['fetch', '--prune', '--tags', 'origin'], {
      cwd: repositoryPath,
      env: gitEnvironment(project, accessToken),
      timeout: 15 * 60_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (!updateWorkingTree) return 'fetched';
    const [branch, status] = await Promise.all([
      execFileAsync('git', ['branch', '--show-current'], { cwd: repositoryPath, timeout: 10_000 }),
      execFileAsync('git', ['status', '--porcelain'], { cwd: repositoryPath, timeout: 30_000 }),
    ]);
    if (branch.stdout.trim() !== project.defaultBranch || status.stdout.trim()) return 'fetched';
    await execFileAsync('git', ['merge', '--ff-only', `origin/${project.defaultBranch}`], {
      cwd: repositoryPath,
      timeout: 5 * 60_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return 'updated';
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
