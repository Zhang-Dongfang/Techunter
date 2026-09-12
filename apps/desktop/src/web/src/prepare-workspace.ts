import type { Project, Task, Workspace, WorkspacePreparationRequest } from '@techunter/core';
import type { DesktopAgentApi, LocalWorkspaceResult } from '../../shared/desktop-contracts';

export interface WorkspaceApi {
  me(): Promise<{ user: { id: string } }>;
  task(id: string): Promise<Task>;
  project(id: string): Promise<Project>;
  workspace(id: string, device: { deviceId: string; deviceLabel: string }): Promise<Workspace>;
  checkoutAuthorization(id: string): Promise<{ token: string }>;
  updateWorkspace(id: string, input: { status: 'provisioning' | 'running' | 'failed'; headSha?: string; setupLog?: string; error?: string | null }): Promise<Workspace>;
}
type Desktop = Pick<DesktopAgentApi, 'identity' | 'locateProject' | 'syncProject' | 'provision'>;
const inFlight = new WeakMap<Desktop, Map<string, Promise<LocalWorkspaceResult>>>();

// Manual preparation and chat actions use the same validation, device ownership,
// single-flight execution and state reporting. Tool transcript text is never executed.
export async function prepareWorkspace(api: WorkspaceApi, desktop: Desktop, taskId: string, userId: string,
  requested?: WorkspacePreparationRequest): Promise<LocalWorkspaceResult> {
  const identity = await desktop.identity();
  const task = await api.task(taskId);
  const assertTask = (current: Task) => {
    if (current.assignee?.id !== userId || current.status !== 'active' || !current.scope || current.pendingOperation) {
      throw new Error('任务状态或执行者已变化，请刷新任务后准备环境。');
    }
  };
  assertTask(task);
  if (requested && (requested.taskId !== taskId || requested.deviceId !== identity.deviceId
    || !task.workspaces?.some(workspace => workspace.id === requested.workspaceId && workspace.userId === userId
      && workspace.deviceId === identity.deviceId && workspace.status !== 'stopped'))) {
    throw new Error('该环境准备请求不属于当前设备或认领已失效。');
  }
  let pending = inFlight.get(desktop);
  if (!pending) { pending = new Map(); inFlight.set(desktop, pending); }
  const key = `${userId}:${taskId}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const work = (async () => {
    const project = await api.project(task.projectId);
    const checkout = await api.checkoutAuthorization(project.id);
    if (!(await desktop.locateProject(project.id)).path) {
      if (!await desktop.syncProject({ project, accessToken: checkout.token })) throw new Error('已取消目录选择，可在任务详情重试准备环境。');
    }
    if ((await api.me()).user.id !== userId) throw new Error('当前登录账号已变化，环境准备已停止。');
    const current = await api.task(taskId);
    assertTask(current);
    // Revalidate a saved chat request after a potentially long directory dialog.
    if (requested && !current.workspaces?.some(workspace => workspace.id === requested.workspaceId && workspace.status !== 'stopped')) {
      throw new Error('原环境准备请求已失效，请从任务详情重新准备。');
    }
    const workspace = await api.workspace(taskId, identity);
    await api.updateWorkspace(workspace.id, { status: 'provisioning' });
    try {
      const result = await desktop.provision({ project, task: current, accessToken: checkout.token });
      await api.updateWorkspace(workspace.id, { status: 'running', headSha: result.headSha, setupLog: result.setupLog, error: null });
      return result;
    } catch (error) {
      await api.updateWorkspace(workspace.id, { status: 'failed', error: (error as Error).message }).catch(() => undefined);
      throw error;
    }
  })();
  pending.set(key, work);
  try { return await work; } finally { pending.delete(key); }
}
