export interface TechunterConfig {
  aiApiKey: string;
  aiBaseUrl?: string;
  aiModel?: string;
  githubToken: string;
  githubClientId?: string; // set when authenticated via Device Flow
  github: {
    owner: string;
    repo: string;
  };
  baseBranch?: string;
  taskState?: TaskState;
}

export interface TaskStateSnapshot {
  activeIssueNumber?: number;
  baseCommit?: string;
  activeBranch?: string;
}

export interface TaskResumeContext {
  originalBranch: string;
  restoreStash: boolean;
  taskStateSnapshot?: TaskStateSnapshot;
}

export interface TaskResumeDecision {
  action: 'restore' | 'stay';
  candidateIndex?: number;
  syncBeforeRestore?: boolean;
  reason: string;
  confidence: 'low' | 'medium' | 'high';
  source: 'heuristic' | 'agent';
}

export interface TaskState {
  activeIssueNumber?: number;
  baseCommit?: string;
  activeBranch?: string;
  resumeStack?: TaskResumeContext[];
}

export interface RepoContext {
  currentBranch: string;
  targetBranch: string;
  hasWorkingTreeChanges: boolean;
  hasSourceOnlyCommits: boolean;
  previousTaskState?: TaskState;
}

export type TaskTransitionAction = 'switch' | 'carry';

export type TaskTransitionStepKind =
  | 'stash_current_worktree'
  | 'switch_to_target_branch'
  | 'carry_source_commits'
  | 'restore_stash_on_target'
  | 'return_to_original_branch'
  | 'sync_original_branch'
  | 'restore_stash_on_original';

export interface TaskTransitionStep {
  kind: TaskTransitionStepKind;
}

export interface TaskTransitionPlanOptions {
  returnToOriginalBranch?: boolean;
  restoreStashOnTarget?: boolean;
}

export interface TaskTransitionPlan {
  action: TaskTransitionAction;
  currentBranch: string;
  targetBranch: string;
  steps: TaskTransitionStep[];
  previousTaskState?: TaskState;
}

export interface TaskTransitionRestoreContext {
  originalBranch: string;
  restoreStash: boolean;
  previousTaskState?: TaskState;
}

export interface TaskTransitionDecision {
  action: TaskTransitionAction;
  reason: string;
  confidence: 'low' | 'medium' | 'high';
  source: 'heuristic' | 'agent';
  proposedSteps?: TaskTransitionStepKind[];
}

export type TaskPublishStepKind =
  | 'stage_and_commit_if_needed'
  | 'sync_branch_with_remote'
  | 'push_branch';

export interface TaskPublishStep {
  kind: TaskPublishStepKind;
}

export interface TaskPublishPlan {
  branch: string;
  commitMessage: string;
  steps: TaskPublishStep[];
}

export type TaskPublishExecutionResult =
  | { ok: true }
  | { ok: false; step: TaskPublishStepKind; message: string };

export type TaskFinalizeStepKind =
  | 'ensure_target_branch'
  | 'merge_branch_into_target'
  | 'merge_target_into_base'
  | 'close_issue'
  | 'lookup_existing_pr'
  | 'create_pr'
  | 'mark_in_review';

export interface TaskFinalizeStep {
  kind: TaskFinalizeStepKind;
}

export interface TaskFinalizePlan {
  mode: 'self-submit' | 'review-submit';
  branch: string;
  targetBranch: string;
  baseBranch: string;
  issueNumber: number;
  steps: TaskFinalizeStep[];
}

export type TaskFinalizeExecutionOutcome =
  | { kind: 'self-submit'; mergePath: string }
  | { kind: 'review-submit'; prUrl: string; existingPr: boolean };

export type TaskFinalizeExecutionResult =
  | { ok: true; outcome: TaskFinalizeExecutionOutcome }
  | {
    ok: false;
    step: TaskFinalizeStepKind;
    message: string;
    prUrl?: string;
    existingPr?: boolean;
    mergePath?: string;
  };

export interface TaskSubmitPlan {
  publish: TaskPublishPlan;
  finalize: TaskFinalizePlan;
}

export type TaskSubmitExecutionResult =
  | { ok: true; outcome: TaskFinalizeExecutionOutcome }
  | {
    ok: false;
    phase: 'publish';
    step: TaskPublishStepKind;
    message: string;
  }
  | {
    ok: false;
    phase: 'finalize';
    step: TaskFinalizeStepKind;
    message: string;
    prUrl?: string;
    existingPr?: boolean;
    mergePath?: string;
  };

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
