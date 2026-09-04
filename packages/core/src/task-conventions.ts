import type { TaskSpec } from './types.js';

export const taskLabels = {
  available: 'techunter:available',
  claimed: 'techunter:claimed',
  inReview: 'techunter:in-review',
  changesNeeded: 'techunter:changes-needed',
} as const;

export const taskLabelDefinitions = [
  { name: taskLabels.available, color: '0e8a16', description: 'Task available to claim' },
  { name: taskLabels.claimed, color: 'e4a000', description: 'Task claimed by a developer' },
  { name: taskLabels.inReview, color: '0075ca', description: 'Task submitted for review' },
  { name: taskLabels.changesNeeded, color: 'e11d48', description: 'Task needs changes' },
] as const;

export const techunterTaskLabels = new Set<string>(Object.values(taskLabels));

const BASE_COMMIT_REGEX = /\n*<!-- techunter-base:[a-f0-9]{7,40} -->/g;
const TARGET_BRANCH_REGEX = /\n*<!-- techunter-target:[^\s>]+ -->/g;
const TASK_ID_REGEX = /\n*<!-- techunter-task-id:[^\s>]+ -->/g;

function branchSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'user';
}

export function makeWorkerBranchName(username: string): string {
  return `worker-${branchSlug(username)}`;
}

export function makeTaskBranchName(issueNumber: number, username: string): string {
  return `task-${issueNumber}-${branchSlug(username)}`;
}

export function taskStatusFromLabels(labels: string[]): 'available' | 'claimed' | 'in-review' | 'changes-needed' | 'unknown' {
  if (labels.includes(taskLabels.changesNeeded)) return 'changes-needed';
  if (labels.includes(taskLabels.inReview)) return 'in-review';
  if (labels.includes(taskLabels.claimed)) return 'claimed';
  if (labels.includes(taskLabels.available)) return 'available';
  return 'unknown';
}

export function stripTaskMetadata(body: string | null | undefined): string {
  if (!body) return '';
  return body.replace(BASE_COMMIT_REGEX, '').replace(TARGET_BRANCH_REGEX, '').replace(TASK_ID_REGEX, '').trimEnd();
}

export function embedBaseCommit(body: string, sha: string): string {
  return `${stripTaskMetadata(body)}\n\n<!-- techunter-base:${sha} -->`;
}

export function extractBaseCommit(body: string | null | undefined): string | null {
  return body?.match(/<!-- techunter-base:([a-f0-9]{7,40}) -->/)?.[1] ?? null;
}

export function embedTargetBranch(body: string, branch: string): string {
  return `${stripTaskMetadata(body)}\n<!-- techunter-target:${branch} -->`;
}

export function extractTargetBranch(body: string | null | undefined): string | null {
  return body?.match(/<!-- techunter-target:([^\s>]+) -->/)?.[1] ?? null;
}

export function embedTaskId(body: string, taskId: string): string {
  return `${stripTaskMetadata(body)}\n<!-- techunter-task-id:${taskId} -->`;
}

export function extractTaskId(body: string | null | undefined): string | null {
  return body?.match(/<!-- techunter-task-id:([^\s>]+) -->/)?.[1] ?? null;
}

export function withTaskMetadata(input: {
  body: string;
  baseCommit?: string | null;
  targetBranch?: string | null;
  taskId?: string | null;
}): string {
  const metadata = [
    input.baseCommit ? `<!-- techunter-base:${input.baseCommit} -->` : '',
    input.targetBranch ? `<!-- techunter-target:${input.targetBranch} -->` : '',
    input.taskId ? `<!-- techunter-task-id:${input.taskId} -->` : '',
  ].filter(Boolean);
  return [stripTaskMetadata(input.body), ...metadata].filter(Boolean).join('\n\n');
}

export function renderTaskGuide(spec: TaskSpec): string {
  return [
    '### Task Description',
    spec.summary,
    '',
    '### Files Involved',
    ...spec.scope.editablePaths.map((file) => `- MODIFY \`${file}\``),
    ...spec.scope.readonlyPaths.map((file) => `- READ \`${file}\``),
    '',
    '### Input / Output',
    spec.rationale,
    '',
    '### Acceptance Criteria',
    ...spec.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`),
    '',
    `<!-- techunter:points=${spec.suggestedPoints};confidence=${spec.confidence} -->`,
  ].join('\n');
}
