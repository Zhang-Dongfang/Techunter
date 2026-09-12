import { expect, it, vi } from 'vitest';
import type { Project, Task, Workspace, WorkspacePreparationRequest } from '@techunter/core';
import { prepareWorkspace } from './prepare-workspace';

function fixture() {
  let workspace = { id: 'workspace', taskId: 'task', userId: 'alice', deviceId: 'device', status: 'queued' } as Workspace;
  const task = { id: 'task', projectId: 'project', status: 'active', assignee: { id: 'alice' }, scope: { revision: 1 },
    workspaces: [workspace], pendingOperation: null } as unknown as Task;
  const project = { id: 'project' } as Project;
  const result = { taskId: 'task', path: 'fixture-workspace', headSha: 'head', setupLog: 'setup passed' };
  const request: WorkspacePreparationRequest = { taskId: 'task', workspaceId: 'workspace', deviceId: 'device' };
  const api = {
    me: vi.fn(async () => ({ user: { id: 'alice' } })),
    task: vi.fn(async () => task), project: vi.fn(async () => project),
    workspace: vi.fn(async () => {
      if (workspace.status === 'failed') { workspace = { ...workspace, id: 'retry-workspace', status: 'queued' }; task.workspaces!.push(workspace); }
      return workspace;
    }),
    checkoutAuthorization: vi.fn(async () => ({ token: 'fixture-only-token' })),
    updateWorkspace: vi.fn(async (_id: string, update: { status: 'provisioning' | 'running' | 'failed'; headSha?: string; setupLog?: string; error?: string | null }) => { Object.assign(workspace, update); return workspace; }),
  };
  const desktop = {
    identity: vi.fn(async () => ({ deviceId: 'device', deviceLabel: 'Fixture' })),
    locateProject: vi.fn(async (): Promise<{ path: string | null }> => ({ path: null })),
    syncProject: vi.fn(async (): Promise<{ projectId: string; path: string; headSha: string; outcome: 'cloned'; workingTreeClean: boolean } | null> => ({ projectId: 'project', path: 'fixture-project', headSha: 'base', outcome: 'cloned', workingTreeClean: true })),
    provision: vi.fn(async (_input: { project: Project; task: Task; accessToken?: string }) => result),
  };
  return { api, desktop, task, project, request, result };
}

it('runs the actual Desktop preparation for a structured chat request and reports head/logs as running', async () => {
  const f = fixture();
  expect(await prepareWorkspace(f.api, f.desktop, 'task', 'alice', f.request)).toEqual(f.result);
  expect(f.desktop.syncProject).toHaveBeenCalledWith({ project: f.project, accessToken: 'fixture-only-token' });
  expect(f.desktop.provision).toHaveBeenCalledWith({ project: f.project, task: f.task, accessToken: 'fixture-only-token' });
  expect(f.api.workspace).toHaveBeenCalledWith('task', { deviceId: 'device', deviceLabel: 'Fixture' });
  expect(f.api.updateWorkspace.mock.calls.map(call => call[1].status)).toEqual(['provisioning', 'running']);
  expect(f.api.updateWorkspace).toHaveBeenLastCalledWith('workspace', { status: 'running', headSha: 'head', setupLog: 'setup passed', error: null });
});

it('shares in-flight work between a chat request and the manual task action', async () => {
  const f = fixture();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.desktop.provision.mockImplementation(async () => { started(); await gate; return f.result; });
  const chat = prepareWorkspace(f.api, f.desktop, 'task', 'alice', f.request);
  await entered;
  const manual = prepareWorkspace(f.api, f.desktop, 'task', 'alice');
  release();
  expect(await Promise.all([chat, manual])).toEqual([f.result, f.result]);
  expect(f.desktop.provision).toHaveBeenCalledTimes(1);
});

it('directory cancellation never runs setup and a later retry remains possible', async () => {
  const f = fixture(); f.desktop.syncProject.mockResolvedValueOnce(null);
  await expect(prepareWorkspace(f.api, f.desktop, 'task', 'alice', f.request)).rejects.toThrow('已取消目录选择');
  expect(f.desktop.provision).not.toHaveBeenCalled(); expect(f.api.updateWorkspace).not.toHaveBeenCalled();
  await prepareWorkspace(f.api, f.desktop, 'task', 'alice', f.request);
  expect(f.desktop.provision).toHaveBeenCalledTimes(1);
});

it('setup failure is reported, then retry uses the new workspace and clears the failure', async () => {
  const f = fixture(); f.desktop.provision.mockRejectedValueOnce(new Error('setup failed'));
  await expect(prepareWorkspace(f.api, f.desktop, 'task', 'alice', f.request)).rejects.toThrow('setup failed');
  expect(f.api.updateWorkspace).toHaveBeenLastCalledWith('workspace', { status: 'failed', error: 'setup failed' });
  await prepareWorkspace(f.api, f.desktop, 'task', 'alice', f.request);
  expect(f.api.updateWorkspace).toHaveBeenLastCalledWith('retry-workspace', { status: 'running', headSha: 'head', setupLog: 'setup passed', error: null });
});

it('rejects other devices/users, stopped claims and pending task operations before local execution', async () => {
  for (const condition of ['device', 'user', 'stopped', 'pending']) {
    const f = fixture();
    if (condition === 'device') f.request.deviceId = 'other';
    if (condition === 'user') f.task.assignee!.id = 'bob';
    if (condition === 'stopped') f.task.workspaces![0]!.status = 'stopped';
    if (condition === 'pending') f.task.pendingOperation = { kind: 'release', id: 'pending' };
    await expect(prepareWorkspace(f.api, f.desktop, 'task', 'alice', f.request)).rejects.toThrow();
    expect(f.desktop.provision).not.toHaveBeenCalled(); expect(f.api.checkoutAuthorization).not.toHaveBeenCalled();
  }
});

it('rechecks account and claim after directory selection instead of executing a stale request', async () => {
  for (const condition of ['account', 'claim', 'scope']) {
    const f = fixture();
    f.desktop.syncProject.mockImplementationOnce(async () => {
      if (condition === 'account') f.api.me.mockResolvedValue({ user: { id: 'bob' } });
      if (condition === 'claim') f.task.workspaces![0]!.status = 'stopped';
      if (condition === 'scope') f.task.scope = { ...f.task.scope!, revision: 2 };
      return { projectId: 'project', path: 'fixture-project', headSha: 'base', outcome: 'cloned', workingTreeClean: true };
    });
    if (condition === 'scope') {
      await prepareWorkspace(f.api, f.desktop, 'task', 'alice', f.request);
      expect(f.desktop.provision.mock.calls[0]![0]).toMatchObject({ task: { scope: { revision: 2 } } });
    } else {
      await expect(prepareWorkspace(f.api, f.desktop, 'task', 'alice', f.request)).rejects.toThrow();
      expect(f.desktop.provision).not.toHaveBeenCalled();
    }
  }
});
