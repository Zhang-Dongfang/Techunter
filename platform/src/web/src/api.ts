import type {
  DashboardResponse,
  LedgerEntry,
  Project,
  Submission,
  Task,
  TaskAnalysis,
  TaskSummary,
  User,
  Workspace,
} from '../../shared/contracts';

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body as T;
}

function post<T>(url: string, body: unknown = {}): Promise<T> {
  return request<T>(url, { method: 'POST', body: JSON.stringify(body) });
}

export const api = {
  dashboard: () => request<DashboardResponse>('/api/dashboard'),
  tasks: (query = '') => request<{ tasks: TaskSummary[] }>(`/api/tasks${query}`),
  task: (id: string) => request<Task>(`/api/tasks/${id}`),
  projects: () => request<{ projects: Project[] }>('/api/projects'),
  createTask: (body: { projectId: string; title: string; description: string; parentTaskId?: string | null }) =>
    post<Task>('/api/tasks', body),
  createSubtask: (parentId: string, body: { projectId: string; title: string; description: string }) =>
    post<Task>(`/api/tasks/${parentId}/subtasks`, body),
  analyze: (id: string) => post<{ analysis: TaskAnalysis; task: Task }>(`/api/tasks/${id}/analyze`),
  publish: (id: string, rewardPoints: number) => post<Task>(`/api/tasks/${id}/publish`, { rewardPoints }),
  claim: (id: string) => post<Task>(`/api/tasks/${id}/claim`),
  release: (id: string) => post<Task>(`/api/tasks/${id}/release`),
  workspace: (id: string) => post<Workspace>(`/api/tasks/${id}/workspaces`),
  submit: (id: string, body: { summary: string; testOutput: string }) => post<Submission>(`/api/tasks/${id}/submissions`, body),
  accept: (submissionId: string) => post<Task>(`/api/submissions/${submissionId}/accept`),
  requestChanges: (submissionId: string, reason: string) =>
    post<Task>(`/api/submissions/${submissionId}/request-changes`, { reason }),
  points: () => request<{ available: number; reserved: number; entries: LedgerEntry[] }>('/api/points'),
  demoUsers: () => request<{ users: User[] }>('/api/auth/demo-users'),
  switchDemoUser: (login: string) => post<{ user: User }>('/api/auth/demo', { login }),
};
