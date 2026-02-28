export interface TechunterConfig {
  anthropicApiKey: string;
  githubToken: string;
  githubClientId?: string; // set when authenticated via Device Flow
  github: {
    owner: string;
    repo: string;
  };
}

export interface TaskGuide {
  summary: string;
  context: string;
  prerequisites: string[];
  inputs: string[];
  outputs: string[];
  acceptanceCriteria: string[];
  suggestedSteps: string[];
  filesToModify: string[];
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  assignee: string | null;
  labels: string[];
  htmlUrl: string;
}

export interface ProjectContext {
  fileTree: string;
  keyFiles: Record<string, string>;
}
