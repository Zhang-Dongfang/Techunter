import type { DeliveryReview, TaskScope, TaskSpec } from './types.js';

export const taskStatuses = ['draft', 'open', 'active', 'submitted', 'accepted', 'cancelled'] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const submissionStatuses = ['pending', 'reviewing', 'approved', 'changes_requested', 'rejected'] as const;
export type SubmissionStatus = (typeof submissionStatuses)[number];

export const workspaceStatuses = ['queued', 'provisioning', 'running', 'stopped', 'failed'] as const;
export type WorkspaceStatus = (typeof workspaceStatuses)[number];

export type Role = 'admin' | 'maintainer' | 'member';

export interface User {
  id: string;
  login: string;
  name: string;
  avatarUrl: string | null;
  email: string | null;
  githubLogin: string | null;
  role: Role;
}

export interface ConexusAuthConfig {
  apiUrl: string;
  publicationSlug: string;
  displayName: string;
}

export interface ConexusAccountUser {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  status: string;
  monthlyTokenLimit: number;
}

export interface ConexusAccountAuthorization {
  runTicket: string;
  expiresAt: string;
  user: ConexusAccountUser;
}

export interface Project {
  id: string;
  githubRepositoryId: number;
  name: string;
  description: string;
  repoOwner: string;
  repoName: string;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
  visibility: 'public' | 'private' | 'internal';
  headSha: string;
  availablePoints: number;
  importedBy: User | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubRepositoryCandidate {
  githubRepositoryId: number;
  name: string;
  fullName: string;
  description: string;
  owner: string;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
  visibility: 'public' | 'private' | 'internal';
  permissions: {
    admin: boolean;
    maintain: boolean;
    push: boolean;
    pull: boolean;
  };
  imported: boolean;
}

export type TaskAnalysis = TaskSpec;

export interface Task {
  id: string;
  projectId: string;
  projectName: string;
  parentTaskId: string | null;
  rootTaskId: string | null;
  title: string;
  description: string;
  summary: string;
  acceptanceCriteria: string[];
  status: TaskStatus;
  rewardPoints: number;
  publisher: User;
  assignee: User | null;
  reviewer: User | null;
  baseSha: string;
  targetBranch: string;
  githubIssueNumber: number | null;
  githubIssueUrl: string | null;
  analysis: TaskAnalysis | null;
  scope: TaskScope | null;
  workspace: Workspace | null;
  latestSubmission: Submission | null;
  children: TaskSummary[];
  createdAt: string;
  updatedAt: string;
}

export type TaskSummary = Pick<
  Task,
  | 'id'
  | 'projectId'
  | 'projectName'
  | 'parentTaskId'
  | 'title'
  | 'summary'
  | 'status'
  | 'rewardPoints'
  | 'publisher'
  | 'assignee'
  | 'createdAt'
  | 'updatedAt'
>;

export interface Workspace {
  id: string;
  taskId: string;
  status: WorkspaceStatus;
  provider: 'local_agent';
  deviceId: string;
  deviceLabel: string;
  headSha: string;
  setupLog: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PackageFile {
  path: string;
  content: string | null;
  encoding: 'utf-8' | 'base64';
}

export interface Submission {
  id: string;
  taskId: string;
  author: User;
  status: SubmissionStatus;
  summary: string;
  testOutput: string;
  pullRequestUrl: string | null;
  review: DeliveryReview | null;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntry {
  id: string;
  type: string;
  amount: number;
  fromLabel: string;
  toLabel: string;
  taskId: string | null;
  memo: string;
  createdAt: string;
}

export interface DashboardResponse {
  me: User;
  projects: Project[];
  tasks: TaskSummary[];
  myAvailablePoints: number;
  reviewCount: number;
  runtime: {
    agentConfigured: boolean;
    agentModel: string | null;
    githubConfigured: boolean;
    githubAccountLinkConfigured: boolean;
    githubConnected: boolean;
    modelAccessMode: 'direct' | 'conexus';
    conexusAuthorizationRequired: boolean;
    modelAuthorizationExpiresAt: string | null;
  };
}

export interface AgentActivity {
  name: string;
  input: Record<string, unknown>;
  result?: string;
}

export interface AgentChatResponse {
  reply: string;
  activities: AgentActivity[];
}
