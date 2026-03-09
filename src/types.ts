export interface TechunterConfig {
  aiApiKey: string;
  aiBaseUrl?: string;
  aiModel?: string;
  githubToken: string;
  githubClientId?: string; // set when authenticated via Device Flow
  github: {
    owner: string;
    repo: string;
    baseBranch?: string;
  };
  taskState?: {
    activeIssueNumber?: number;
    baseCommit?: string;
  };
}

export interface TaskGuide {
  summary: string;
  acceptanceCriteria: string[];
  optionalImprovements: string[];
  suggestedSteps: string[];
  filesToModify: string[];
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: string | null;
  assignee: string | null;
  labels: string[];
  htmlUrl: string;
}

export interface ProjectContext {
  fileTree: string;
  keyFiles: Record<string, string>;
}
