import type { PackageFile, Project, Task } from '@techunter/core';

export interface LocalWorkspaceResult {
  taskId: string;
  path: string;
  headSha: string;
  setupLog: string;
}

export interface DesktopAgentApi {
  apiBaseUrl: string;
  identity(): Promise<{ deviceId: string; deviceLabel: string }>;
  provision(input: { project: Project; task: Task; accessToken?: string }): Promise<LocalWorkspaceResult>;
  locate(taskId: string): Promise<{ path: string | null }>;
  collectChanges(input: { task: Task }): Promise<{ path: string; files: PackageFile[] }>;
  run(input: { command: string; cwd?: string }): Promise<{ sessionId: string }>;
  cancel(sessionId: string): Promise<void>;
  onOutput(listener: (event: { sessionId: string; stream: 'stdout' | 'stderr'; data: string }) => void): () => void;
  onExit(listener: (event: { sessionId: string; exitCode: number | null }) => void): () => void;
  platform: string;
}
