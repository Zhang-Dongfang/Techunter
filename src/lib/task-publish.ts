import type { TaskPublishExecutionResult, TaskPublishPlan, TaskPublishStepKind } from '../types.js';
import { pushCurrentBranch, stageAndCommitIfNeeded, syncBranchWithRemote } from './git.js';

export function buildTaskPublishPlan(branch: string, commitMessage: string): TaskPublishPlan {
  return {
    branch,
    commitMessage,
    steps: [
      { kind: 'stage_and_commit_if_needed' },
      { kind: 'sync_branch_with_remote' },
      { kind: 'push_branch' },
    ],
  };
}

function hasStep(plan: TaskPublishPlan, kind: TaskPublishStepKind): boolean {
  return plan.steps.some((step) => step.kind === kind);
}

export function summarizeTaskPublishPlan(plan: TaskPublishPlan): string {
  return plan.steps.map((step) => step.kind).join(' -> ');
}

export async function executeTaskPublishPlan(plan: TaskPublishPlan): Promise<TaskPublishExecutionResult> {
  if (hasStep(plan, 'stage_and_commit_if_needed')) {
    try {
      await stageAndCommitIfNeeded(plan.commitMessage);
    } catch (err) {
      return { ok: false, step: 'stage_and_commit_if_needed', message: (err as Error).message };
    }
  }

  if (hasStep(plan, 'sync_branch_with_remote')) {
    try {
      await syncBranchWithRemote(plan.branch);
    } catch (err) {
      return { ok: false, step: 'sync_branch_with_remote', message: (err as Error).message };
    }
  }

  if (hasStep(plan, 'push_branch')) {
    try {
      await pushCurrentBranch(plan.branch);
    } catch (err) {
      return { ok: false, step: 'push_branch', message: (err as Error).message };
    }
  }

  return { ok: true };
}
