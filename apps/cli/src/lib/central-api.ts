import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { collectTaskChanges, DEFAULT_CONEXUS_AUDIENCE, extractTaskId, makeTaskBranchName, type Project, type Submission, type Task, type User, type Workspace } from '@techunter/core';
import type { GitHubIssue, TechunterConfig } from '../types.js';
import { ensureConexusCredential } from './conexus-account.js';
import { setConfig } from './config.js';

const exec = promisify(execFile);
export const isCentralTask = (issue: Pick<GitHubIssue, 'body'>): boolean => Boolean(extractTaskId(issue.body));

export function centralApiOrigin(config: TechunterConfig): string {
  const value = config.centralApiUrl || process.env['TECHUNTER_API_URL'];
  if (!value) throw new Error('此任务由中央 API 管理。请在 tch config 中设置 Central API，并登录对应的 Conexus 账号。');
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    throw new Error('Central API 必须是 HTTPS origin；回环开发地址可以使用 HTTP。');
  }
  return url.origin;
}

class CentralApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

type Session = { cookie: string; expiresAt: number };
const sessions = new Map<string, Promise<Session>>();

export async function centralClient(config: TechunterConfig) {
  const origin = centralApiOrigin(config);
  if (config.aiAccessMode !== 'conexus') throw new Error('中央任务需要 Conexus 身份。请先运行 tch config 切换到 Conexus 并登录。');
  const current = await ensureConexusCredential(config);
  const key = createHash('sha256').update(origin + '\n' + current.aiApiKey).digest('hex');
  const decode = async <T>(response: Response): Promise<T> => {
    const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
    if (!response.ok) throw new CentralApiError(body.error || `中央 API 请求失败 (${response.status})`, response.status, body.code);
    return body as T;
  };
  const login = async (): Promise<Session> => {
    const response = await fetch(`${origin}/api/auth/conexus`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runTicket: current.aiApiKey, audience: current.aiAudience ?? DEFAULT_CONEXUS_AUDIENCE }),
    });
    const body = await decode<{ session: { expiresAt: string } }>(response);
    const cookie = response.headers.get('set-cookie')?.match(/(?:^|,\s*)techunter_session=([^;]+)/)?.[1];
    if (!cookie) throw new Error('中央 API 没有返回登录会话。');
    return { cookie: `techunter_session=${cookie}`, expiresAt: Math.min(Date.parse(body.session.expiresAt), Date.now() + 24 * 60 * 60_000) };
  };
  let saved = sessions.get(key);
  if (!saved || (await saved).expiresAt <= Date.now()) {
    saved = login(); sessions.set(key, saved);
    saved.catch(() => { sessions.delete(key); });
  }
  const session = await saved;
  const request = async <T>(route: string, method = 'GET', body?: unknown): Promise<T> => {
    try {
      return await decode<T>(await fetch(`${origin}${route}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15 * 60_000),
        headers: { cookie: session.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
    } catch (error) {
      if (error instanceof CentralApiError && error.code === 'UNAUTHENTICATED') sessions.delete(key);
      throw error;
    }
  };
  const me = await request<{ user: User; githubConnected: boolean }>('/api/auth/me');
  const { getAuthenticatedUser } = await import('./github.js');
  const loginName = await getAuthenticatedUser(config);
  if (!me.githubConnected || me.user.githubLogin?.toLowerCase() !== loginName.toLowerCase()) {
    throw new Error('中央账号连接的 GitHub 身份与 CLI 不一致。请在 Desktop 中连接当前 CLI 使用的 GitHub 账号。');
  }
  return { request, user: me.user };
}

export async function centralTask(config: TechunterConfig, issue: Pick<GitHubIssue, 'body' | 'number'>) {
  const id = extractTaskId(issue.body);
  if (!id) throw new Error('任务缺少中央 task ID。');
  const client = await centralClient(config);
  const task = await client.request<Task>(`/api/tasks/${encodeURIComponent(id)}`);
  const project = await client.request<Project>(`/api/projects/${task.projectId}`);
  if (task.githubIssueNumber !== issue.number || `${project.repoOwner}/${project.repoName}`.toLowerCase() !== `${config.github.owner}/${config.github.repo}`.toLowerCase()) {
    throw new Error('Issue 元数据与中央任务所属仓库不一致，操作已停止。');
  }
  return { client, task };
}

export async function submitCentralTask(config: TechunterConfig, issue: GitHubIssue, summary: string, testOutput: string): Promise<Submission> {
  const { client, task } = await centralTask(config, issue);
  if (task.status === 'submitted' && task.latestSubmission?.status === 'reviewing') {
    return client.request<Submission>(`/api/submissions/${task.latestSubmission.id}/resume`, 'POST', {});
  }
  if (task.status !== 'active' || task.assignee?.id !== client.user.id) throw new Error('只能提交自己正在执行的中央任务。');
  const cwd = (await exec('git', ['rev-parse', '--show-toplevel'], { windowsHide: true })).stdout.trim();
  const branch = makeTaskBranchName(issue.number, client.user.githubLogin!);
  const current = (await exec('git', ['branch', '--show-current'], { cwd, windowsHide: true })).stdout.trim();
  if (current !== branch) throw new Error(`请先切换到任务分支 ${branch} 再提交。`);
  await exec('git', ['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`], {
    cwd, windowsHide: true, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const changes = await collectTaskChanges(cwd, task);
  if (!config.centralDeviceId) { config.centralDeviceId = randomUUID(); setConfig({ centralDeviceId: config.centralDeviceId }); }
  const workspace = await client.request<Workspace>(`/api/tasks/${task.id}/workspaces`, 'POST', { deviceId: config.centralDeviceId, deviceLabel: `${os.hostname()} · CLI` });
  await client.request(`/api/workspaces/${workspace.id}`, 'PATCH', { status: 'running', headSha: changes.headSha, setupLog: 'CLI 使用执行者已准备的本机工作区。' });
  return client.request<Submission>(`/api/tasks/${task.id}/submissions`, 'POST', { summary, testOutput, files: changes.files, headSha: changes.headSha });
}

export async function acceptCentralTask(config: TechunterConfig, issue: GitHubIssue): Promise<Task> {
  const { client, task } = await centralTask(config, issue);
  if (!task.latestSubmission) throw new Error('中央任务尚无交付记录。');
  return client.request<Task>(`/api/submissions/${task.latestSubmission.id}/accept`, 'POST', {});
}

export async function rejectCentralTask(config: TechunterConfig, issue: GitHubIssue, reason: string): Promise<void> {
  const { client, task } = await centralTask(config, issue);
  if (!task.latestSubmission) throw new Error('中央任务尚无交付记录。');
  await client.request(`/api/submissions/${task.latestSubmission.id}/request-changes`, 'POST', { reason });
}
