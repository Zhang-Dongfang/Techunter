import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { collectTaskChanges, taskRemoteHead, readLocalTechunterConfig, type Project, type Task } from '@techunter/core';
import type { LocalProjectSyncResult, LocalWorkspaceResult } from '../shared/desktop-contracts.js';

const execFileAsync = promisify(execFile);

export function gitEnvironment(project: Project, accessToken?: string): NodeJS.ProcessEnv {
  const token = accessToken?.trim() || readLocalTechunterConfig().config?.githubToken?.trim();
  if (!token || project.visibility === 'public') return process.env;
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    GIT_CONFIG_KEY_1: 'http.followRedirects',
    GIT_CONFIG_VALUE_1: 'false',
  };
}

function safeRemote(value: string): string {
  if (path.isAbsolute(value)) return value;
  try {
    const url = new URL(value.trim());
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      url.username = '';
      url.password = '';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return value.trim();
  }
}

export function remoteMatchesProject(remote: string, project: Project): boolean {
  // Local repositories are useful for offline fixtures; never compare only a URL suffix.
  if (path.isAbsolute(project.cloneUrl) && path.isAbsolute(remote)) {
    const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    return normalize(remote) === normalize(project.cloneUrl);
  }
  const githubPath = (value: string): string | null => {
    const scp = /^git@github\.com:([^?#]+)$/i.exec(value);
    if (scp) return scp[1]!.replace(/\.git$/i, '').toLowerCase();
    try {
      const url = new URL(value);
      if (url.hostname !== 'github.com' || url.port || url.search || url.hash ||
        !['https:', 'ssh:'].includes(url.protocol)) return null;
      if (url.protocol === 'ssh:' && url.username !== 'git') return null;
      return url.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/i, '').toLowerCase();
    } catch { return null; }
  };
  const expected = `${project.repoOwner}/${project.repoName}`.toLowerCase();
  return githubPath(project.cloneUrl) === expected && githubPath(remote) === expected;
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
    if (!remoteMatchesProject(project.cloneUrl, project)) throw new Error('项目的 GitHub clone 地址无效。');
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
      await execFileAsync('git', ['clone', '--filter=blob:none', safeRemote(project.cloneUrl), repositoryPath], {
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
    const remoteHead = await taskRemoteHead(task, workspacePath);
    if (remoteHead) {
      // Git preserves unrelated uncommitted work and refuses unsafe overwrites.
      // Conflicts remain in this worktree for the user to resolve explicitly.
      try {
        await execFileAsync('git', ['-c', 'user.name=Techunter', '-c', 'user.email=agent@techunter.local', 'merge', '--no-edit', remoteHead], {
          cwd: workspacePath, timeout: 60_000, windowsHide: true,
        });
      } catch (error) { throw new Error(`同步远程任务成果失败，请先保存本机改动并处理合并冲突，再重试环境准备。\n${(error as Error).message}`); }
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
    if (safeRemote(remote) !== remote) await execFileAsync('git', ['remote', 'set-url', 'origin', safeRemote(remote)], { cwd: repositoryPath, timeout: 10_000 });
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

  async test(task: Task): Promise<{ output: string; passed: boolean; packageDigest: string }> {
    const before = await this.collectChanges(task);
    const commands = task.scope?.environment.testCommands ?? [];
    if (!commands.length) throw new Error('任务没有配置测试命令，请在命令台验证后填写测试结果。');
    const log = [`本机测试 · ${new Date().toISOString()}`];
    let passed = true;
    for (const command of commands) {
      log.push(`\n> ${command}`);
      try { log.push(await runShell(command, before.path), '退出码：0'); }
      catch (error) { passed = false; log.push((error as Error).message); }
    }
    const after = await this.collectChanges(task);
    if (before.packageDigest !== after.packageDigest) throw new Error('测试期间交付文件发生变化，请检查生成的文件并重新测试。');
    const output = log.join('\n');
    return { output: output.length > 95_000 ? `${output.slice(0, 95_000)}\n[测试日志超出上限，后续内容未显示]` : output, passed, packageDigest: after.packageDigest };
  }

  async collectChanges(task: Task) {
    return collectTaskChanges(path.join(this.workspacesRoot, task.id), task);
  }
}
