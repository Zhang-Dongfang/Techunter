import { z } from 'zod';
import type {
  GitHubIssue,
  RepoContext,
  TaskTransitionAction,
  TaskTransitionDecision,
  TaskTransitionPlanOptions,
  TaskTransitionStepKind,
  TaskState,
  TechunterConfig,
} from '../types.js';
import { createClient, getModel } from './client.js';
import { stripTaskMetadata } from './github.js';
import { getDiff, getDiffFromCommit } from './git.js';
import { buildTaskTransitionPlan } from './task-transition.js';

type PlannerOptions = {
  preferredAction?: TaskTransitionAction;
  allowAgent?: boolean;
  goal?: 'claim' | 'submit' | 'switch-fix';
  planOptions?: TaskTransitionPlanOptions;
};

const stepKinds = [
  'stash_current_worktree',
  'switch_to_target_branch',
  'carry_source_commits',
  'restore_stash_on_target',
  'return_to_original_branch',
  'sync_original_branch',
  'restore_stash_on_original',
] as const satisfies readonly TaskTransitionStepKind[];

const decisionSchema = z.object({
  action: z.enum(['switch', 'carry']),
  reason: z.string().min(1),
  confidence: z.enum(['low', 'medium', 'high']),
  steps: z.array(z.enum(stepKinds)).optional(),
});

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n... (truncated)` : text;
}

export function buildFallbackTaskTransitionDecision(
  context: RepoContext,
  preferredAction?: TaskTransitionAction,
): TaskTransitionDecision {
  if (preferredAction) {
    return {
      action: preferredAction,
      reason: `The caller explicitly requested ${preferredAction}.`,
      confidence: 'high',
      source: 'heuristic',
      proposedSteps: undefined,
    };
  }

  if (!context.hasWorkingTreeChanges && !context.hasSourceOnlyCommits) {
    return {
      action: 'switch',
      reason: 'There is no local work on the current branch to carry over.',
      confidence: 'high',
      source: 'heuristic',
      proposedSteps: undefined,
    };
  }

  if (context.hasWorkingTreeChanges && !context.hasSourceOnlyCommits) {
    return {
      action: 'switch',
      reason: 'Only uncommitted work is present; defaulting to switch is safer than moving it automatically.',
      confidence: 'medium',
      source: 'heuristic',
      proposedSteps: undefined,
    };
  }

  return {
    action: 'switch',
    reason: 'Cross-task changes were detected, so switching is the safer default when intent is ambiguous.',
    confidence: 'medium',
    source: 'heuristic',
    proposedSteps: undefined,
  };
}

async function summarizeCurrentWork(previousTaskState: TaskState | undefined, currentBranch: string): Promise<string> {
  if (
    previousTaskState?.activeBranch === currentBranch &&
    previousTaskState.baseCommit
  ) {
    return truncate(await getDiffFromCommit(previousTaskState.baseCommit), 12_000);
  }

  return truncate(await getDiff(), 12_000);
}

export async function planTaskTransitionDecision(
  config: TechunterConfig,
  issue: GitHubIssue,
  context: RepoContext,
  options: PlannerOptions = {},
): Promise<TaskTransitionDecision> {
  const fallback = buildFallbackTaskTransitionDecision(context, options.preferredAction);
  if (!options.allowAgent) return fallback;
  if (!context.hasWorkingTreeChanges && !context.hasSourceOnlyCommits) return fallback;

  const allowedStepKinds = buildTaskTransitionPlan(context, fallback.action, options.planOptions)
    .steps
    .map((step) => step.kind);
  if (allowedStepKinds.length === 0) return fallback;

  let currentWorkSummary = '';
  try {
    currentWorkSummary = await summarizeCurrentWork(context.previousTaskState, context.currentBranch);
  } catch {
    return fallback;
  }

  const client = createClient(config);
  const system = [
    'You are deciding how Techunter should move between git task contexts.',
    options.preferredAction
      ? `The action is fixed to "${options.preferredAction}". Do not choose any other action.`
      : 'Choose between exactly two actions: "switch" or "carry".',
    'Prefer "switch" when uncertain, because it avoids mixing work between tasks.',
    'Choose "carry" only when the current branch work clearly belongs to the selected target task.',
    `Allowed step kinds for this transition: ${allowedStepKinds.join(', ')}`,
    'Propose a safe step plan for the chosen action.',
    'Respond with JSON only: {"action":"switch|carry","reason":"...","confidence":"low|medium|high","steps":["..."]}',
  ].join('\n');

  const user = [
    `Operation: ${options.goal ?? 'submit'}`,
    `Current branch: ${context.currentBranch}`,
    `Target task branch: ${context.targetBranch}`,
    `Selected task: #${issue.number} ${issue.title}`,
    '',
    'Selected task description:',
    stripTaskMetadata(issue.body ?? '') || '(empty)',
    '',
    `Has uncommitted changes: ${String(context.hasWorkingTreeChanges)}`,
    `Has source-only commits: ${String(context.hasSourceOnlyCommits)}`,
    '',
    'Summary of current branch work:',
    currentWorkSummary || '(no diff summary available)',
  ].join('\n');

  try {
    const res = await client.chat.completions.create({
      model: getModel(config),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
    });

    const content = res.choices[0]?.message?.content?.trim();
    if (!content) return fallback;

    const parsed = decisionSchema.safeParse(JSON.parse(content));
    if (!parsed.success) return fallback;
    if (options.preferredAction && parsed.data.action !== options.preferredAction) return fallback;

    return {
      action: parsed.data.action,
      reason: parsed.data.reason,
      confidence: parsed.data.confidence,
      source: 'agent',
      proposedSteps: parsed.data.steps,
    };
  } catch {
    return fallback;
  }
}
