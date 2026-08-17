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
  role: Role;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  localRepoPath: string | null;
  availablePoints: number;
}

export interface TaskScope {
  revision: number;
  editablePaths: string[];
  readonlyPaths: string[];
  deniedPaths: string[];
  visibleTests: string[];
  environment: {
    image: string;
    setupCommands: string[];
    testCommands: string[];
    networkAllowlist: string[];
  };
}

export interface TaskAnalysis {
  summary: string;
  acceptanceCriteria: string[];
  scope: TaskScope;
  suggestedPoints: number;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
}

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
  provider: 'package' | 'docker' | 'coder';
  packagePath: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewFinding {
  criterion: string;
  passed: boolean;
  evidence: string;
}

export interface ReviewResult {
  score: number;
  verdict: 'approved' | 'changes_requested';
  summary: string;
  findings: ReviewFinding[];
  risks: string[];
  deliveryDocument: string;
}

export interface Submission {
  id: string;
  taskId: string;
  author: User;
  status: SubmissionStatus;
  summary: string;
  testOutput: string;
  pullRequestUrl: string | null;
  review: ReviewResult | null;
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
}

export interface ApiErrorShape {
  error: string;
  code?: string;
}

export interface DesktopTerminalApi {
  run(input: { command: string; cwd?: string }): Promise<{ sessionId: string }>;
  cancel(sessionId: string): Promise<void>;
  onOutput(listener: (event: { sessionId: string; stream: 'stdout' | 'stderr'; data: string }) => void): () => void;
  onExit(listener: (event: { sessionId: string; exitCode: number | null }) => void): () => void;
  platform: string;
}
