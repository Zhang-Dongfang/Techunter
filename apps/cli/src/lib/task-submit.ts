import type { GitHubIssue, TaskSubmitExecutionResult, TaskSubmitPlan, TechunterConfig } from '../types.js';
import { buildTaskFinalizePlan, executeTaskFinalizePlan, summarizeTaskFinalizePlan } from './task-finalize.js';
import { buildTaskPublishPlan, executeTaskPublishPlan, summarizeTaskPublishPlan } from './task-publish.js';
import { isCentralTask } from './central-api.js';

export function buildTaskSubmitPlan(options: {
  issue: GitHubIssue;
  branch: string;
  targetBranch: string;
  baseBranch: string;
  commitMessage: string;
  isSelfSubmit: boolean;
}): TaskSubmitPlan {
  return {
    publish: buildTaskPublishPlan(options.branch, options.commitMessage),
    finalize: buildTaskFinalizePlan({
      mode: options.isSelfSubmit ? 'self-submit' : 'review-submit',
      issueNumber: options.issue.number,
      branch: options.branch,
      targetBranch: options.targetBranch,
      baseBranch: options.baseBranch,
    }),
  };
}

export function summarizeTaskSubmitPlan(plan: TaskSubmitPlan): string {
  return [
    `publish: ${summarizeTaskPublishPlan(plan.publish)}`,
    `finalize: ${summarizeTaskFinalizePlan(plan.finalize)}`,
  ].join('\n');
}

export async function executeTaskSubmitPlan(
  config: TechunterConfig,
  plan: TaskSubmitPlan,
  issue: GitHubIssue,
  review: string,
): Promise<TaskSubmitExecutionResult> {
  if (isCentralTask(issue)) throw new Error('中央任务必须通过中央 API 提交交付包。');
  const publishResult = await executeTaskPublishPlan(plan.publish);
  if (!publishResult.ok) {
    return { ok: false, phase: 'publish', step: publishResult.step, message: publishResult.message };
  }

  const finalizeResult = await executeTaskFinalizePlan(config, plan.finalize, issue, review);
  if (!finalizeResult.ok) {
    return {
      ok: false,
      phase: 'finalize',
      step: finalizeResult.step,
      message: finalizeResult.message,
      prUrl: finalizeResult.prUrl,
      existingPr: finalizeResult.existingPr,
      mergePath: finalizeResult.mergePath,
    };
  }

  return { ok: true, outcome: finalizeResult.outcome };
}
