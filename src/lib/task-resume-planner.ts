import { z } from 'zod';
import type { TaskResumeContext, TaskResumeDecision, TaskState, TechunterConfig } from '../types.js';
import { createClient, getModel } from './client.js';
import { listStashes } from './git.js';

const decisionSchema = z.object({
  action: z.enum(['restore', 'stay']),
  candidateIndex: z.number().int().min(0).optional(),
  reason: z.string().min(1),
  confidence: z.enum(['low', 'medium', 'high']),
});

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n... (truncated)` : text;
}

export function buildResumeCandidates(taskState: TaskState | undefined, issueNumber: number): TaskResumeContext[] {
  if (taskState?.activeIssueNumber !== issueNumber || !taskState.resumeStack || taskState.resumeStack.length === 0) {
    return [];
  }

  return taskState.resumeStack.map((entry, index) => {
    const remaining = taskState.resumeStack?.slice(0, index) ?? [];
    return {
      originalBranch: entry.originalBranch,
      restoreStash: entry.restoreStash,
      taskStateSnapshot: entry.taskStateSnapshot
        ? {
          ...entry.taskStateSnapshot,
          resumeStack: remaining.length > 0 ? remaining : undefined,
        }
        : (remaining.length > 0
          ? {
            activeIssueNumber: undefined,
            baseCommit: undefined,
            activeBranch: undefined,
            resumeStack: remaining,
          }
          : undefined),
    };
  }).reverse();
}

export function buildFallbackTaskResumeDecision(candidates: TaskResumeContext[]): TaskResumeDecision {
  if (candidates.length === 0) {
    return {
      action: 'stay',
      reason: 'There is no deferred parent context to restore after this submit.',
      confidence: 'high',
      source: 'heuristic',
    };
  }

  const restorable = candidates.findIndex((candidate) => candidate.restoreStash);
  return {
    action: 'restore',
    candidateIndex: restorable >= 0 ? restorable : 0,
    reason: restorable >= 0
      ? 'A deferred parent context has stashed work waiting to be restored.'
      : 'A deferred parent context exists, so returning there is the safest completion state.',
    confidence: 'high',
    source: 'heuristic',
  };
}

export async function planPostSubmitResume(
  config: TechunterConfig,
  options: {
    issueNumber: number;
    currentBranch: string;
    taskState: TaskState | undefined;
    immediateRestore?: TaskResumeContext;
  },
): Promise<{ decision: TaskResumeDecision; selectedContext?: TaskResumeContext }> {
  const deferredCandidates = buildResumeCandidates(options.taskState, options.issueNumber);
  const candidates = options.immediateRestore
    ? [options.immediateRestore, ...deferredCandidates]
    : deferredCandidates;
  const fallback = buildFallbackTaskResumeDecision(candidates);
  if (candidates.length === 0) {
    return { decision: fallback };
  }

  let stashSummary = '';
  try {
    const stashes = await listStashes();
    stashSummary = truncate(
      stashes.slice(0, 10).map((stash) => `${stash.ref}: ${stash.message}`).join('\n') || '(none)',
      4_000,
    );
  } catch {
    stashSummary = '(unavailable)';
  }

  const client = createClient(config);
  const system = [
    'You are deciding the best post-submit repository state for Techunter.',
    'Prefer restoring the most relevant deferred parent context when it contains stashed work or unfinished parent-task state.',
    'Choose "stay" only when staying on the current branch is clearly safer than restoring any deferred parent context.',
    'Respond with JSON only: {"action":"restore|stay","candidateIndex":0,"reason":"...","confidence":"low|medium|high"}',
  ].join('\n');

  const user = [
    `Submitted task: #${options.issueNumber}`,
    `Current branch after submit: ${options.currentBranch}`,
    '',
    'Deferred resume candidates (index 0 is the most recent context):',
    candidates.map((candidate, index) => (
      [
        `- index=${index}`,
        `  branch=${candidate.originalBranch}`,
        `  restoreStash=${String(candidate.restoreStash)}`,
        `  snapshotIssue=${candidate.taskStateSnapshot?.activeIssueNumber ?? 'none'}`,
        `  snapshotBranch=${candidate.taskStateSnapshot?.activeBranch ?? 'none'}`,
      ].join('\n')
    )).join('\n'),
    '',
    'Current stash list:',
    stashSummary,
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
    if (!content) {
      return {
        decision: fallback,
        selectedContext: fallback.action === 'restore' && fallback.candidateIndex !== undefined
          ? candidates[fallback.candidateIndex]
          : undefined,
      };
    }

    const parsed = decisionSchema.safeParse(JSON.parse(content));
    if (!parsed.success) {
      return {
        decision: fallback,
        selectedContext: fallback.action === 'restore' && fallback.candidateIndex !== undefined
          ? candidates[fallback.candidateIndex]
          : undefined,
      };
    }

    if (parsed.data.action === 'restore') {
      const index = parsed.data.candidateIndex ?? 0;
      const selectedContext = candidates[index];
      if (!selectedContext) {
        return {
          decision: fallback,
          selectedContext: fallback.action === 'restore' && fallback.candidateIndex !== undefined
            ? candidates[fallback.candidateIndex]
            : undefined,
        };
      }

      return {
        decision: {
          action: 'restore',
          candidateIndex: index,
          reason: parsed.data.reason,
          confidence: parsed.data.confidence,
          source: 'agent',
        },
        selectedContext,
      };
    }

    return {
      decision: {
        action: 'stay',
        reason: parsed.data.reason,
        confidence: parsed.data.confidence,
        source: 'agent',
      },
    };
  } catch {
    return {
      decision: fallback,
      selectedContext: fallback.action === 'restore' && fallback.candidateIndex !== undefined
        ? candidates[fallback.candidateIndex]
        : undefined,
    };
  }
}
