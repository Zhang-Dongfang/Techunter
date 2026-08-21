import type {
  GitHubIssue,
  RepoContext,
  TaskTransitionAction,
  TaskTransitionPlan,
  TaskTransitionPlanOptions,
  TaskTransitionRestoreContext,
  TaskTransitionStep,
  TaskTransitionStepKind,
} from '../types.js';
import { setConfig } from './config.js';
import { extractBaseCommit } from './github.js';
import {
  abortMergeOperation,
  checkoutFromCommit,
  squashMergeBranch,
  resolveBranchRef,
  stash,
  stashPop,
  switchToBranchOrCreate,
  syncBranchWithRemote,
} from './git.js';

export function buildTaskTransitionPlan(
  context: RepoContext,
  action: TaskTransitionAction,
  options: TaskTransitionPlanOptions = {},
): TaskTransitionPlan {
  const steps: TaskTransitionStep[] = [];
  const returnToOriginalBranch = options.returnToOriginalBranch ?? action === 'switch';
  const restoreStashOnTarget = options.restoreStashOnTarget ?? (action === 'carry' && context.hasWorkingTreeChanges);
  if (context.currentBranch !== context.targetBranch) {
    if (context.hasWorkingTreeChanges) {
      steps.push({ kind: 'stash_current_worktree' });
    }

    steps.push({ kind: 'switch_to_target_branch' });

    if (action === 'carry' && context.hasSourceOnlyCommits) {
      steps.push({ kind: 'carry_source_commits' });
    }

    if (restoreStashOnTarget && context.hasWorkingTreeChanges) {
      steps.push({ kind: 'restore_stash_on_target' });
    }

    if (returnToOriginalBranch) {
      steps.push({ kind: 'return_to_original_branch' });
      steps.push({ kind: 'sync_original_branch' });
      if (context.hasWorkingTreeChanges) {
        steps.push({ kind: 'restore_stash_on_original' });
      }
    }
  }

  return {
    action,
    currentBranch: context.currentBranch,
    targetBranch: context.targetBranch,
    steps,
    previousTaskState:
      context.previousTaskState?.activeBranch === context.currentBranch ? context.previousTaskState : undefined,
  };
}

function hasStep(plan: TaskTransitionPlan, kind: TaskTransitionStepKind): boolean {
  return plan.steps.some((step) => step.kind === kind);
}

function preservesOrder(
  candidate: TaskTransitionStepKind[],
  canonical: TaskTransitionStepKind[],
): boolean {
  let index = 0;
  for (const step of candidate) {
    while (index < canonical.length && canonical[index] !== step) index++;
    if (index >= canonical.length) return false;
    index++;
  }
  return true;
}

export function buildValidatedTaskTransitionPlan(
  context: RepoContext,
  action: TaskTransitionAction,
  proposedSteps?: TaskTransitionStepKind[],
  options: TaskTransitionPlanOptions = {},
): { plan: TaskTransitionPlan; source: 'agent' | 'heuristic' } {
  const fallback = buildTaskTransitionPlan(context, action, options);
  if (!proposedSteps || proposedSteps.length === 0) {
    return { plan: fallback, source: 'heuristic' };
  }

  const fallbackKinds = fallback.steps.map((step) => step.kind);
  const proposedKinds = [...proposedSteps];

  if (new Set(proposedKinds).size !== proposedKinds.length) {
    return { plan: fallback, source: 'heuristic' };
  }

  if (!proposedKinds.every((kind) => fallbackKinds.includes(kind))) {
    return { plan: fallback, source: 'heuristic' };
  }

  if (!preservesOrder(proposedKinds, fallbackKinds)) {
    return { plan: fallback, source: 'heuristic' };
  }

  const requiredKinds: TaskTransitionStepKind[] = [];
  if (context.currentBranch !== context.targetBranch) {
    requiredKinds.push('switch_to_target_branch');
    if (context.hasWorkingTreeChanges) {
      requiredKinds.push('stash_current_worktree');
      if (action === 'carry') {
        requiredKinds.push('restore_stash_on_target');
      }
    }
    if (action === 'carry' && context.hasSourceOnlyCommits) {
      requiredKinds.push('carry_source_commits');
    }
  }

  if (!requiredKinds.every((kind) => proposedKinds.includes(kind))) {
    return { plan: fallback, source: 'heuristic' };
  }

  return {
    plan: {
      ...fallback,
      steps: proposedKinds.map((kind) => ({ kind })),
    },
    source: 'agent',
  };
}

export function summarizeTaskTransitionPlan(plan: TaskTransitionPlan): string {
  if (plan.steps.length === 0) return 'stay_on_target_branch';

  const labels: Record<TaskTransitionStepKind, string> = {
    stash_current_worktree: 'stash_current_worktree',
    switch_to_target_branch: 'switch_to_target_branch',
    carry_source_commits: 'carry_source_commits',
    restore_stash_on_target: 'restore_stash_on_target',
    return_to_original_branch: 'return_to_original_branch',
    sync_original_branch: 'sync_original_branch',
    restore_stash_on_original: 'restore_stash_on_original',
  };

  return plan.steps.map((step) => labels[step.kind]).join(' -> ');
}

async function setActiveTaskState(issue: GitHubIssue, taskBranch: string): Promise<void> {
  setConfig({
    taskState: {
      activeIssueNumber: issue.number,
      baseCommit: extractBaseCommit(issue.body) ?? undefined,
      activeBranch: taskBranch,
    },
  });
}

async function switchToTaskBranch(issue: GitHubIssue, targetBranch: string): Promise<string> {
  const taskBase = extractBaseCommit(issue.body);

  if (taskBase) {
    await checkoutFromCommit(targetBranch, taskBase);
  } else {
    const branchRef = await resolveBranchRef(targetBranch);
    if (!branchRef) {
      throw new Error(`Task branch ${targetBranch} does not exist yet. Claim or recreate the task branch first.`);
    }
    await switchToBranchOrCreate(targetBranch);
  }

  await setActiveTaskState(issue, targetBranch);
  return targetBranch;
}

export async function applyTaskTransition(
  issue: GitHubIssue,
  plan: TaskTransitionPlan,
): Promise<{
  branch: string;
  notices: string[];
  restore?: TaskTransitionRestoreContext;
  deferredRestore?: TaskTransitionRestoreContext;
}> {
  if (plan.currentBranch === plan.targetBranch) {
    await setActiveTaskState(issue, plan.targetBranch);
    return { branch: plan.targetBranch, notices: [] };
  }

  const notices: string[] = [];
  let stashed = false;
  let switched = false;
  let stashRestoredOnTarget = false;
  let mergeAttempted = false;

  try {
    if (hasStep(plan, 'stash_current_worktree')) {
      await stash(`tch: before submit #${issue.number} from ${plan.currentBranch}`);
      stashed = true;
    }

    const branch = await switchToTaskBranch(issue, plan.targetBranch);
    switched = true;

    if (hasStep(plan, 'carry_source_commits')) {
      mergeAttempted = true;
      await squashMergeBranch(plan.currentBranch);
      notices.push(`Brought committed work from ${plan.currentBranch} into ${branch}.`);
    }

    if (hasStep(plan, 'restore_stash_on_target') && stashed) {
      await stashPop();
      stashRestoredOnTarget = true;
      notices.push(`Restored your unsaved work on ${branch}.`);
    } else if (stashed) {
      notices.push(`Saved your unsaved work from ${plan.currentBranch} while preparing #${issue.number}.`);
    }

    return {
      branch,
      notices,
      restore: hasStep(plan, 'return_to_original_branch')
        ? {
          originalBranch: plan.currentBranch,
          restoreStash: hasStep(plan, 'restore_stash_on_original') && !stashRestoredOnTarget,
          previousTaskState: plan.previousTaskState,
        }
        : undefined,
      deferredRestore: !hasStep(plan, 'return_to_original_branch')
        ? {
          originalBranch: plan.currentBranch,
          restoreStash: stashed && !stashRestoredOnTarget,
          previousTaskState: plan.previousTaskState,
        }
        : undefined,
    };
  } catch (err) {
    const rollbackNotices: string[] = [];

    if (mergeAttempted) {
      await abortMergeOperation();
    }

    if (switched) {
      try {
        await switchToBranchOrCreate(plan.currentBranch);
        rollbackNotices.push(`Returned to ${plan.currentBranch}.`);
      } catch (rollbackErr) {
        rollbackNotices.push(
          `Could not return to ${plan.currentBranch} automatically: ${(rollbackErr as Error).message}`,
        );
      }
    }

    if (stashed && !stashRestoredOnTarget) {
      try {
        await stashPop();
        rollbackNotices.push(`Restored your unsaved work on ${plan.currentBranch}.`);
      } catch (stashErr) {
        rollbackNotices.push(
          `Could not restore your unsaved work automatically: ${(stashErr as Error).message}`,
        );
      }
    }

    const details = rollbackNotices.length > 0 ? `\n${rollbackNotices.join('\n')}` : '';
    throw new Error(`Could not prepare task #${issue.number}: ${(err as Error).message}${details}`);
  }
}

export async function restoreTaskTransitionContext(
  context: TaskTransitionRestoreContext,
  options: { syncBranch?: boolean } = {},
): Promise<string[]> {
  const notices: string[] = [];
  const syncBranch = options.syncBranch ?? true;

  try {
    await switchToBranchOrCreate(context.originalBranch);
    notices.push(`Returned to ${context.originalBranch}.`);
  } catch (err) {
    notices.push(`Could not return to ${context.originalBranch} automatically: ${(err as Error).message}`);
    if (context.restoreStash) {
      notices.push('Your stashed work was kept unchanged.');
    }
    return notices;
  }

  if (syncBranch) {
    try {
      const syncResult = await syncBranchWithRemote(context.originalBranch);
      if (syncResult.mode === 'fast-forward') {
        notices.push(`Fast-forwarded ${context.originalBranch} to the latest origin/${context.originalBranch}.`);
      } else if (syncResult.mode === 'merge') {
        notices.push(
          `Merged the latest origin/${context.originalBranch} into ${context.originalBranch} before restoring your work.`,
        );
      }
    } catch (err) {
      notices.push(`Could not sync ${context.originalBranch} with origin/${context.originalBranch}: ${(err as Error).message}`);
      if (context.restoreStash) {
        notices.push('Your stashed work was not restored because the branch needs manual sync first.');
      }
      setConfig({
        taskState: context.previousTaskState ?? {
          activeIssueNumber: undefined,
          baseCommit: undefined,
          activeBranch: undefined,
          resumeStack: undefined,
        },
      });
      return notices;
    }
  } else {
    notices.push(`Skipped syncing ${context.originalBranch} with origin/${context.originalBranch} before restoring your work.`);
  }

  if (context.restoreStash) {
    try {
      await stashPop();
      notices.push(`Restored your stashed work on ${context.originalBranch}.`);
    } catch (err) {
      notices.push(`Could not restore your stashed work automatically on ${context.originalBranch}: ${(err as Error).message}`);
    }
  }

  setConfig({
    taskState: context.previousTaskState ?? {
      activeIssueNumber: undefined,
      baseCommit: undefined,
      activeBranch: undefined,
      resumeStack: undefined,
    },
  });

  return notices;
}
