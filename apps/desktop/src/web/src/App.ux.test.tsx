// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DashboardResponse, Project, Task, User } from '@techunter/core';
import { App } from './App';
import { api } from './api';
vi.mock('./api', async () => {
  const { ApiError } = await import('./http-request');
  return { ApiError, api: { dashboard: vi.fn(), task: vi.fn(), points: vi.fn(), claim: vi.fn() } };
});
vi.mock('./AgentDock', () => ({ AgentDock: () => null }));

const me: User = { id: 'user', name: '用户', login: 'user', role: 'member', avatarUrl: null, email: null, githubLogin: null };
const project: Project = { id: 'project', githubRepositoryId: 1, name: '示例项目', description: '', repoOwner: 'fixture', repoName: 'repo', cloneUrl: '', htmlUrl: '', defaultBranch: 'main', sourceBranch: 'main', visibility: 'public', headSha: 'base', availablePoints: 100, importedBy: me, createdAt: '2026-10-08', updatedAt: '2026-10-08' };
function task(id: string): Task {
  return { id, version: 1, projectId: project.id, projectName: project.name, parentTaskId: null, rootTaskId: null, title: `任务 ${id}`, description: '', summary: '', acceptanceCriteria: [], status: 'open', rewardPoints: 10, publisher: me, assignee: null, reviewer: null, baseSha: 'base', targetBranch: 'main', githubIssueNumber: null, githubIssueUrl: null, analysis: null, scope: null, workspace: null, latestSubmission: null, children: [], createdAt: '2026-10-08', updatedAt: '2026-10-08' };
}
const dashboard: DashboardResponse = { me, projects: [project], tasks: [task('a'), task('b')], myAvailablePoints: 20, reviewCount: 0, runtime: { agentConfigured: false, agentModel: null, githubConfigured: false, githubConnected: false, githubAccountLinkConfigured: false, modelAccessMode: 'direct', conexusAuthorizationRequired: false, modelAuthorizationExpiresAt: null } };
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.dashboard).mockResolvedValue(dashboard); });
afterEach(cleanup);
async function openDirectory() {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: /示例项目/ }));
}

it('a late response from an earlier task cannot replace the newer task', async () => {
  const a = deferred<Task>(), b = deferred<Task>();
  vi.mocked(api.task).mockImplementation(id => id === 'a' ? a.promise : b.promise);
  await openDirectory();
  fireEvent.click(screen.getByRole('button', { name: /任务 a/ }));
  fireEvent.click(screen.getByRole('button', { name: /任务 b/ }));
  await act(async () => { b.resolve(task('b')); });
  expect(within(screen.getByRole('dialog')).getByRole('heading', { name: '任务 b' })).toBeTruthy();
  await act(async () => { a.resolve(task('a')); });
  expect(within(screen.getByRole('dialog')).getByRole('heading', { name: '任务 b' })).toBeTruthy();
  expect(vi.mocked(api.task).mock.calls[0]![1]!.aborted).toBe(true);
});

it('cancelling task loading prevents its response from opening a dialog', async () => {
  const pending = deferred<Task>(); vi.mocked(api.task).mockReturnValue(pending.promise);
  await openDirectory();
  fireEvent.click(screen.getByRole('button', { name: /任务 a/ }));
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await act(async () => { pending.resolve(task('a')); });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('a completed action refreshes data without reopening a closed detail dialog', async () => {
  const claim = deferred<Task>(); vi.mocked(api.claim).mockReturnValue(claim.promise);
  vi.mocked(api.task).mockResolvedValue(task('a'));
  await openDirectory();
  fireEvent.click(screen.getByRole('button', { name: /任务 a/ }));
  fireEvent.click(await screen.findByRole('button', { name: '认领这个任务' }));
  fireEvent.keyDown(window, { key: 'Escape' });
  await act(async () => { claim.resolve(task('a')); });
  await waitFor(() => expect(api.dashboard).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('shows loading and offers a retry instead of reporting an empty ledger on failure', async () => {
  const pending = deferred<Awaited<ReturnType<typeof api.points>>>();
  vi.mocked(api.points).mockReturnValueOnce(pending.promise);
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: /贡献点/ }));
  expect(screen.getByText('正在加载账单…')).toBeTruthy();
  expect(screen.queryByText('还没有账单')).toBeNull();
  await act(async () => { pending.resolve({ available: 20, reserved: 0, entries: [] }); });
  await screen.findByText('还没有账单');
  vi.mocked(api.points).mockRejectedValueOnce(new Error('账单暂时不可用'));
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await screen.findByText('账单暂时不可用');
  vi.mocked(api.points).mockResolvedValueOnce({ available: 20, reserved: 0, entries: [] });
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.queryByText('账单暂时不可用')).toBeNull());
});
