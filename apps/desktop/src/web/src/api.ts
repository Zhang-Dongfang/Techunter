import type {
  AgentChatMessage,
  AgentChatResponse,
  ConexusAccountAuthorization,
  ConexusAuthConfig,
  DashboardResponse,
  GitHubBranch,
  LedgerEntry,
  Project,
  Submission,
  Task,
  TaskAnalysis,
  TaskSummary,
  User,
  Workspace,
  GitHubRepositoryCandidate,
  PackageFile,
  ScopeRequest,
  ScopeRequestInput,
  ScopeRequestDecision,
} from '@techunter/core';
import { retryTransientRequest } from './request-retry';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const apiBaseUrl = (window.techunterDesktop?.apiBaseUrl || import.meta.env.VITE_TECHUNTER_API_URL || '').replace(/\/+$/, '');

function endpoint(path: string): string {
  return apiBaseUrl ? new URL(path, `${apiBaseUrl}/`).toString() : path;
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(endpoint(url), {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
  if (!response.ok) {
    if (body.code === 'CONEXUS_AUTHORIZATION_REQUIRED') {
      window.dispatchEvent(new Event('techunter:conexus-authorization-required'));
    }
    throw new ApiError(body.error || `请求失败 (${response.status})`, response.status, body.code);
  }
  return body as T;
}

function post<T>(url: string, body: unknown = {}): Promise<T> {
  return request<T>(url, { method: 'POST', body: JSON.stringify(body) });
}

export const api = {
  conexusConfig: () => request<ConexusAuthConfig>('/api/auth/conexus/config'),
  authorizeConexus: (authorization: ConexusAccountAuthorization, audience: string) =>
    post<{ user: User; session: { expiresAt: string; idleExpiresAt: string }; modelAuthorizationExpiresAt: string }>('/api/auth/conexus', {
      runTicket: authorization.runTicket,
      audience,
    }),
  refreshConexus: (authorization: ConexusAccountAuthorization, audience: string) =>
    post<{ user: User; modelAuthorizationExpiresAt: string }>('/api/auth/conexus/refresh', {
      runTicket: authorization.runTicket,
      audience,
    }),
  me: () => request<{
    user: User;
    githubConnected: boolean;
    modelAuthorizationExpiresAt: string | null;
    session: { expiresAt: string; idleExpiresAt: string };
  }>('/api/auth/me'),
  logout: () => post<{ ok: boolean }>('/api/auth/logout'),
  beginGitHubAuthorization: () => post<{ authorizationUrl: string }>('/api/auth/github'),
  disconnectGitHub: () => request<{ ok: boolean }>('/api/auth/github', { method: 'DELETE' }),
  dashboard: () => request<DashboardResponse>('/api/dashboard'),
  tasks: (query = '') => request<{ tasks: TaskSummary[] }>(`/api/tasks${query}`),
  task: (id: string) => request<Task>(`/api/tasks/${id}`),
  projects: () => request<{ projects: Project[] }>('/api/projects'),
  githubRepositories: () => request<{ repositories: GitHubRepositoryCandidate[] }>('/api/github/repositories'),
  importProject: (githubRepositoryId: number) => post<Project>('/api/projects/import', { githubRepositoryId }),
  projectBranches: (projectId: string) => retryTransientRequest(() =>
    request<{ branches: GitHubBranch[]; sourceBranch: string }>(`/api/projects/${projectId}/branches`)),
  switchProjectBranch: (projectId: string, sourceBranch: string) => request<Project>(`/api/projects/${projectId}/branch`, {
    method: 'PATCH',
    body: JSON.stringify({ sourceBranch }),
  }),
  checkoutAuthorization: (projectId: string) => request<{ token: string; expiresAt: string | null }>(`/api/projects/${projectId}/checkout-authorization`),
  requestProjectCollaboration: (projectId: string) => post<{ status: 'invited' | 'already_collaborator'; actionUrl: string }>(`/api/projects/${projectId}/collaboration-request`),
  createTask: (body: { projectId: string; title: string; description: string; parentTaskId?: string | null }) =>
    post<Task>('/api/tasks', body),
  createSubtask: (parentId: string, body: { projectId: string; title: string; description: string }) =>
    post<Task>(`/api/tasks/${parentId}/subtasks`, body),
  removeTask: (id: string) => request<{ id: string; disposition: 'deleted' | 'cancelled' }>(`/api/tasks/${id}`, { method: 'DELETE' }),
  analyze: (id: string) => post<{ analysis: TaskAnalysis; task: Task }>(`/api/tasks/${id}/analyze`),
  publish: (id: string, rewardPoints: number) => post<Task>(`/api/tasks/${id}/publish`, { rewardPoints }),
  cancelPublication: (id: string) => post<Task>(`/api/tasks/${id}/cancel-publication`),
  claim: (id: string) => post<Task>(`/api/tasks/${id}/claim`),
  release: (id: string) => post<Task>(`/api/tasks/${id}/release`),
  scopeRequests: (id: string) => request<{ requests: ScopeRequest[] }>(`/api/tasks/${id}/scope-requests`),
  requestScope: (id: string, body: ScopeRequestInput) => post<ScopeRequest>(`/api/tasks/${id}/scope-requests`, body),
  decideScope: (id: string, requestId: string, body: ScopeRequestDecision) =>
    post<{ request: ScopeRequest; task: Task; githubSynced: boolean | null }>(`/api/tasks/${id}/scope-requests/${requestId}/decision`, body),
  withdrawScope: (id: string, requestId: string) => post<ScopeRequest>(`/api/tasks/${id}/scope-requests/${requestId}/withdraw`),
  syncScope: (id: string) => post<{ synced: boolean }>(`/api/tasks/${id}/scope/sync`),
  workspace: (id: string, body: { deviceId: string; deviceLabel: string }) => post<Workspace>(`/api/tasks/${id}/workspaces`, body),
  updateWorkspace: (id: string, body: { status: 'provisioning' | 'running' | 'failed'; headSha?: string; setupLog?: string; error?: string | null }) =>
    request<Workspace>(`/api/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  submit: (id: string, body: { workspaceId: string; summary: string; testOutput: string; files: PackageFile[]; headSha: string }) => post<Submission>(`/api/tasks/${id}/submissions`, body),
  resumeSubmission: (id: string) => post<Submission>(`/api/submissions/${id}/resume`),
  accept: (submissionId: string) => post<Task>(`/api/submissions/${submissionId}/accept`),
  requestChanges: (submissionId: string, reason: string) =>
    post<Task>(`/api/submissions/${submissionId}/request-changes`, { reason }),
  points: () => request<{ available: number; reserved: number; entries: LedgerEntry[] }>('/api/points'),
  chat: (body: { message: string; history: AgentChatMessage[]; projectId?: string; deviceId?: string; deviceLabel?: string }) =>
    post<AgentChatResponse>('/api/agent/chat', body),
};
