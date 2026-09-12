import type { ConexusAccountAuthorization, PackageFile, Project, Task } from '@techunter/core';

export interface LocalWorkspaceResult {
  taskId: string;
  path: string;
  headSha: string;
  setupLog: string;
}

export interface LocalProjectSyncResult {
  projectId: string;
  path: string;
  headSha: string;
  outcome: 'cloned' | 'updated' | 'fetched';
  workingTreeClean: boolean;
}

export type DesktopUpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error';

export interface DesktopUpdateState {
  status: DesktopUpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  progress?: number;
  message?: string;
}

export interface DesktopAgentApi {
  apiBaseUrl: string;
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<void>;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
  authorizeConexus(input: { apiUrl: string; publicationSlug: string; displayName: string }): Promise<ConexusAccountAuthorization>;
  openAuthenticationUrl(url: string): Promise<void>;
  identity(): Promise<{ deviceId: string; deviceLabel: string }>;
  syncProject(input: { project: Project; accessToken?: string }): Promise<LocalProjectSyncResult | null>;
  locateProject(projectId: string): Promise<{ path: string | null }>;
  provision(input: { project: Project; task: Task; accessToken?: string }): Promise<LocalWorkspaceResult>;
  locate(taskId: string): Promise<{ path: string | null }>;
  collectChanges(input: { task: Task }): Promise<{ path: string; files: PackageFile[]; headSha: string; packageDigest: string }>;
  test(input: { task: Task }): Promise<{ output: string; passed: boolean; packageDigest: string }>;
  run(input: { command: string; cwd?: string }): Promise<{ sessionId: string }>;
  cancel(sessionId: string): Promise<void>;
  onOutput(listener: (event: { sessionId: string; stream: 'stdout' | 'stderr'; data: string }) => void): () => void;
  onExit(listener: (event: { sessionId: string; exitCode: number | null }) => void): () => void;
  platform: string;
}
