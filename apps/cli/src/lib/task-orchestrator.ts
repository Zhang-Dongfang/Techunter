import type {
  GitHubIssue,
  RepoContext,
  TaskState,
  TaskTransitionAction,
  TaskTransitionDecision,
  TaskTransitionPlan,
  TaskTransitionPlanOptions,
  TechunterConfig,
} from '../types.js';
import { observeRepoContext } from './repo-context.js';
import { planTaskTransitionDecision } from './task-transition-planner.js';
import { buildValidatedTaskTransitionPlan } from './task-transition.js';

export async function recommendTaskTransition(
  config: TechunterConfig,
  issue: GitHubIssue,
  currentBranch: string,
  targetBranch: string,
  previousTaskState?: TaskState,
  preferredAction?: TaskTransitionAction,
  planOptions: TaskTransitionPlanOptions = {},
  goal: 'claim' | 'submit' | 'switch-fix' = 'submit',
): Promise<{ context: RepoContext; decision: TaskTransitionDecision; plan: TaskTransitionPlan; planSource: 'agent' | 'heuristic' }> {
  const context = await observeRepoContext(currentBranch, targetBranch, previousTaskState);
  const decision = await planTaskTransitionDecision(config, issue, context, {
    preferredAction,
    allowAgent: true,
    goal,
    planOptions,
  });
  const { plan, source } = buildValidatedTaskTransitionPlan(context, decision.action, decision.proposedSteps, planOptions);

  return { context, decision, plan, planSource: source };
}

export function formatPlannerNotice(decision: TaskTransitionDecision, verb: 'recommended' | 'chose' = 'recommended'): string {
  return `Planner: ${decision.source} ${verb} ${decision.action} (${decision.confidence}) - ${decision.reason}`;
}
