import type {
  GitHubIssue,
  TaskFinalizeExecutionResult,
  TaskFinalizePlan,
  TaskFinalizeStepKind,
  TechunterConfig,
} from '../types.js';
import {
  closeTask,
  createPR,
  ensureRemoteBranch,
  getTaskPR,
  markInReview,
  mergeBranchIntoBase,
} from './github.js';

export function buildTaskFinalizePlan(options: {
  mode: 'self-submit' | 'review-submit';
  issueNumber: number;
  branch: string;
  targetBranch: string;
  baseBranch: string;
  existingPrUrl?: string;
}): TaskFinalizePlan {
  const steps: TaskFinalizePlan['steps'] = [];

  if (options.mode === 'self-submit') {
    if (options.branch !== options.targetBranch) {
      steps.push({ kind: 'ensure_target_branch' });
      steps.push({ kind: 'merge_branch_into_target' });
    }
    if (!/^task-\d+-/.test(options.targetBranch) && options.targetBranch !== options.baseBranch) {
      steps.push({ kind: 'merge_target_into_base' });
    }
    steps.push({ kind: 'close_issue' });
  } else {
    steps.push({ kind: 'lookup_existing_pr' });
    if (!options.existingPrUrl) {
      steps.push({ kind: 'ensure_target_branch' });
      steps.push({ kind: 'create_pr' });
    }
    steps.push({ kind: 'mark_in_review' });
  }

  return {
    mode: options.mode,
    branch: options.branch,
    targetBranch: options.targetBranch,
    baseBranch: options.baseBranch,
    issueNumber: options.issueNumber,
    steps,
  };
}

function hasStep(plan: TaskFinalizePlan, kind: TaskFinalizeStepKind): boolean {
  return plan.steps.some((step) => step.kind === kind);
}

export function summarizeTaskFinalizePlan(plan: TaskFinalizePlan): string {
  return plan.steps.map((step) => step.kind).join(' -> ');
}

export async function executeTaskFinalizePlan(
  config: TechunterConfig,
  plan: TaskFinalizePlan,
  issue: GitHubIssue,
  review: string,
): Promise<TaskFinalizeExecutionResult> {
  if (plan.mode === 'self-submit') {
    let finalBranch = plan.targetBranch;

    if (hasStep(plan, 'ensure_target_branch')) {
      try {
        await ensureRemoteBranch(config, plan.targetBranch, plan.baseBranch);
      } catch (err) {
        return { ok: false, step: 'ensure_target_branch', message: (err as Error).message };
      }
    }

    if (hasStep(plan, 'merge_branch_into_target')) {
      try {
        await mergeBranchIntoBase(config, plan.branch, plan.targetBranch);
      } catch (err) {
        return { ok: false, step: 'merge_branch_into_target', message: (err as Error).message };
      }
    }

    if (hasStep(plan, 'merge_target_into_base')) {
      try {
        await mergeBranchIntoBase(config, plan.targetBranch, plan.baseBranch);
        finalBranch = plan.baseBranch;
      } catch (err) {
        return {
          ok: false,
          step: 'merge_target_into_base',
          message: (err as Error).message,
          mergePath: `${plan.branch} -> ${plan.targetBranch}`,
        };
      }
    }

    if (hasStep(plan, 'close_issue')) {
      try {
        await closeTask(config, issue.number);
      } catch (err) {
        return {
          ok: false,
          step: 'close_issue',
          message: (err as Error).message,
          mergePath: finalBranch === plan.targetBranch
            ? `${plan.branch} -> ${plan.targetBranch}`
            : `${plan.branch} -> ${plan.targetBranch} -> ${finalBranch}`,
        };
      }
    }

    const mergePath = finalBranch === plan.targetBranch
      ? `${plan.branch} -> ${plan.targetBranch}`
      : `${plan.branch} -> ${plan.targetBranch} -> ${finalBranch}`;

    return { ok: true, outcome: { kind: 'self-submit', mergePath } };
  }

  let existingPR = false;
  let prUrl = '';

  if (hasStep(plan, 'lookup_existing_pr')) {
    try {
      const pr = await getTaskPR(config, issue.number, plan.branch);
      if (pr) {
        existingPR = true;
        prUrl = pr.url;
      }
    } catch (err) {
      return { ok: false, step: 'lookup_existing_pr', message: (err as Error).message };
    }
  }

  if (hasStep(plan, 'ensure_target_branch')) {
    try {
      await ensureRemoteBranch(config, plan.targetBranch, plan.baseBranch);
    } catch (err) {
      return {
        ok: false,
        step: 'ensure_target_branch',
        message: (err as Error).message,
        prUrl: prUrl || undefined,
        existingPr: existingPR || undefined,
      };
    }
  }

  if (hasStep(plan, 'create_pr')) {
    const prBody = [
      `Closes #${issue.number}`,
      issue.body ? `\n${issue.body}` : '',
      review ? `\n## AI Review\n${review}` : '',
    ].join('\n').trim();
    try {
      prUrl = await createPR(config, issue.title, prBody, plan.branch, plan.targetBranch);
    } catch (err) {
      return {
        ok: false,
        step: 'create_pr',
        message: (err as Error).message,
        prUrl: prUrl || undefined,
        existingPr: existingPR || undefined,
      };
    }
  }

  if (hasStep(plan, 'mark_in_review')) {
    try {
      await markInReview(config, issue.number);
    } catch (err) {
      return {
        ok: false,
        step: 'mark_in_review',
        message: (err as Error).message,
        prUrl: prUrl || undefined,
        existingPr: existingPR || undefined,
      };
    }
  }

  return { ok: true, outcome: { kind: 'review-submit', prUrl, existingPr: existingPR } };
}
