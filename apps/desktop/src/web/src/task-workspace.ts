import type { Task, Workspace } from '@techunter/core';

export function deviceWorkspace(task: Pick<Task, 'workspaces' | 'workspace'>, userId: string, deviceId?: string): Workspace | null {
  if (!deviceId) return null;
  const candidates = task.workspaces ?? (task.workspace ? [task.workspace] : []);
  return candidates.filter(workspace => workspace.userId === userId && workspace.deviceId === deviceId && workspace.status !== 'stopped')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] ?? null;
}
