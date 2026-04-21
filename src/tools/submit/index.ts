import chalk from 'chalk';
import ora from 'ora';
import { select, input as promptInput } from '@inquirer/prompts';
import type {
  TechunterConfig,
  GitHubIssue,
  TaskSubmitExecutionResult,
  RepoContext,
  TaskTransitionDecision,
  TaskTransitionRestoreContext,
} from '../../types.js';
import {
  getTask,
  getAuthenticatedUser,
  getIssueNumberFromBranch,
  extractTargetBranch,
  getOpenSubtasks,
  listMyTasks,
  extractBaseCommit,
} from '../../lib/github.js';
import {
  getCurrentBranch,
  getDiff,
  getDiffFromCommit,
  makeTaskBranchName,
  makeWorkerBranchName,
  parseIssueNumberFromBranch,
} from '../../lib/git.js';
import { getConfig, setConfig } from '../../lib/config.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { reviewChanges } from './reviewer.js';
import { getStatus } from '../../lib/display.js';
import { planPostSubmitResume } from '../../lib/task-resume-planner.js';
import { formatPlannerNotice, recommendTaskTransition } from '../../lib/task-orchestrator.js';
import { buildTaskSubmitPlan, summarizeTaskSubmitPlan, executeTaskSubmitPlan } from '../../lib/task-submit.js';
import {
  applyTaskTransition,
  restoreTaskTransitionContext,
  summarizeTaskTransitionPlan,
} from '../../lib/task-transition.js';

const SUBMITTABLE_LABELS = new Set(['techunter:claimed', 'techunter:changes-needed']);

type SubmitOutcome = {
  message: string;
  success: boolean;
};

function isSubmittableTask(issue: GitHubIssue): boolean {
  return issue.labels.some((label) => SUBMITTABLE_LABELS.has(label));
}

async function resolveIssueNumberFromBranch(
  config: TechunterConfig,
  branch: string
): Promise<number | undefined> {
  const fromBranch = parseIssueNumberFromBranch(branch);
  if (fromBranch) return fromBranch;

  const found = await getIssueNumberFromBranch(config, branch);
  return found?.issueNumber;
}

function getTaskBranch(issue: GitHubIssue, username: string): string {
  return makeTaskBranchName(issue.number, issue.assignee ?? username);
}

async function chooseTaskForSubmit(
  config: TechunterConfig,
  username: string,
  currentIssueNumber?: number
): Promise<GitHubIssue | null> {
  const tasks = (await listMyTasks(config, username)).filter(isSubmittableTask);
  if (tasks.length === 0) return null;

  if (tasks.length === 1) return tasks[0] ?? null;

  const ordered = [...tasks].sort((a, b) => {
    if (a.number === currentIssueNumber) return -1;
    if (b.number === currentIssueNumber) return 1;
    return a.number - b.number;
  });

  let issueNumber: number;
  try {
    issueNumber = await select({
      message: 'Submit which task?',
      choices: ordered.map((task) => ({
        name:
          `#${task.number}  [${getStatus(task)}]  ${task.title}` +
          (task.number === currentIssueNumber ? '  (current context)' : ''),
        value: task.number,
      })),
    });
  } catch {
    throw new Error('Cancelled.');
  }

  return ordered.find((task) => task.number === issueNumber) ?? null;
}

async function buildDiffForIssue(issue: GitHubIssue, branch: string): Promise<string> {
  const taskState = getConfig().taskState;
  if (
    taskState?.activeIssueNumber === issue.number &&
    taskState?.activeBranch === branch &&
    taskState.baseCommit
  ) {
    return getDiffFromCommit(taskState.baseCommit);
  }

  const issueBaseCommit = extractBaseCommit(issue.body);
  if (issueBaseCommit) return getDiffFromCommit(issueBaseCommit);

  return getDiff();
}

async function performSubmit(
  config: TechunterConfig,
  issue: GitHubIssue,
  branch: string,
  username: string,
  interactive: boolean,
  commitMessageOverride?: string,
): Promise<SubmitOutcome> {
  let spinner: ReturnType<typeof ora> | undefined;

  if (interactive) spinner = ora('Loading task and diff...').start();
  const [diff] = await Promise.all([buildDiffForIssue(issue, branch)]);
  spinner?.stop();

  const targetBranch = extractTargetBranch(issue.body) ?? makeWorkerBranchName(issue.author ?? username);
  const isSelfSubmit = issue.author !== null && issue.author === username;

  spinner = interactive ? ora('Checking for open sub-tasks...').start() : undefined;
  const openSubtaskNumbers = await getOpenSubtasks(config, branch);
  spinner?.stop();
  if (openSubtaskNumbers.length > 0) {
    return {
      message: interactive
        ? (
          `Cannot submit: ${openSubtaskNumbers.length} sub-task(s) still open:\n` +
          openSubtaskNumbers.map((n) => `  - #${n}`).join('\n') +
          '\nComplete all sub-tasks before submitting.'
        )
        : (
          `Cannot submit: ${openSubtaskNumbers.length} sub-task(s) still open: ` +
          openSubtaskNumbers.map((n) => `#${n}`).join(', ')
        ),
      success: false,
    };
  }

  let review = '';
  if (!isSelfSubmit) {
    spinner = interactive ? ora('Reviewing changes...').start() : undefined;
    try {
      review = await reviewChanges(config, issue.number, issue, diff);
    } catch (err) {
      review = `(Review failed: ${(err as Error).message})`;
    }
    spinner?.stop();
  }

  if (interactive) {
    const divider = chalk.dim('-'.repeat(70));
    console.log('\n' + divider);
    if (isSelfSubmit) {
      console.log(chalk.yellow('  Self-submit detected - AI review skipped.'));
    } else {
      console.log(chalk.bold(`  Review - task #${issue.number} "${issue.title}"`));
      console.log(divider);
      console.log(renderMarkdown(review));
    }
    console.log(divider + '\n');

    let shouldProceed: boolean;
    try {
      shouldProceed = await select({
        message: `Submit task #${issue.number}?`,
        choices: [
          { name: 'Yes, submit', value: true },
          { name: 'No, not ready yet', value: false },
        ],
      });
    } catch {
      return { message: 'Submit cancelled.', success: false };
    }
    if (!shouldProceed) return { message: 'Submit cancelled by user.', success: false };
  }

  let commitMessage = commitMessageOverride?.trim();
  if (!commitMessage) {
    if (interactive) {
      try {
        commitMessage = await promptInput({
          message: 'Commit message:',
          default: `complete: ${issue.title}`,
        });
      } catch {
        return { message: 'Submit cancelled.', success: false };
      }
      if (!commitMessage.trim()) return { message: 'Submit cancelled.', success: false };
    } else {
      commitMessage = `complete: ${issue.title}`;
    }
  }

  const submitPlan = buildTaskSubmitPlan({
    issue,
    branch,
    targetBranch,
    baseBranch: config.baseBranch ?? 'main',
    commitMessage: commitMessage.trim(),
    isSelfSubmit,
  });

  if (interactive) {
    console.log(chalk.dim('  Submit plan:'));
    console.log(chalk.dim(`    ${summarizeTaskSubmitPlan(submitPlan).replace('\n', '\n    ')}`));
  }

  spinner = interactive ? ora('Publishing changes...').start() : undefined;
  try {
    const submitResult = await executeTaskSubmitPlan(config, submitPlan, issue, review);
    spinner?.stop();

    if (!submitResult.ok) {
      return {
        message: formatSubmitFailure(submitResult, submitPlan),
        success: false,
      };
    }

    if (submitResult.outcome.kind === 'self-submit') {
      return {
        message: `Task #${issue.number} committed and closed.\nMerged: ${submitResult.outcome.mergePath}\nCommit: "${commitMessage.trim()}"`,
        success: true,
      };
    }

    return {
      message: interactive
        ? `Task #${issue.number} ${submitResult.outcome.existingPr ? 're-submitted' : 'submitted'}.\nCommit: "${commitMessage.trim()}"\nPR: ${submitResult.outcome.prUrl}`
        : `Task #${issue.number} ${submitResult.outcome.existingPr ? 're-submitted' : 'submitted'}.\nReview:\n${review}\nCommit: "${commitMessage.trim()}"\nPR: ${submitResult.outcome.prUrl}`,
      success: true,
    };
  } catch (err) {
    spinner?.stop();
    return {
      message: `Submit failed after planning publish/finalize for ${branch}: ${(err as Error).message}`,
      success: false,
    };
  }
}

function formatSubmitResult(result: string, notices: string[]): string {
  if (notices.length === 0) return result;
  return `${notices.map((notice) => `Note: ${notice}`).join('\n')}\n\n${result}`;
}

function shouldConfirmPlannerTransition(
  context: RepoContext,
  decision: TaskTransitionDecision,
): boolean {
  if (decision.confidence === 'low') return true;
  if (decision.action === 'carry' && context.hasWorkingTreeChanges) return true;
  return false;
}

async function finalizePostSubmitContext(
  config: TechunterConfig,
  issueNumber: number,
  branch: string,
  immediateRestore: TaskTransitionRestoreContext | undefined,
): Promise<string[]> {
  const taskState = getConfig().taskState;
  const { decision, selectedContext } = await planPostSubmitResume(config, {
    issueNumber,
    currentBranch: branch,
    taskState,
    immediateRestore,
  });

  const notices = [
    `Resume planner: ${decision.source} chose ${decision.action} (${decision.confidence}) - ${decision.reason}`,
  ];

  if (decision.action === 'restore' && selectedContext) {
    const restored = await restoreTaskTransitionContext(selectedContext);
    return notices.concat(restored);
  }

  setConfig({
    taskState: {
      activeIssueNumber: undefined,
      baseCommit: undefined,
      activeBranch: undefined,
      resumeStack: undefined,
    },
  });
  return notices;
}

function formatSubmitFailure(
  result: Extract<TaskSubmitExecutionResult, { ok: false }>,
  plan: ReturnType<typeof buildTaskSubmitPlan>,
): string {
  if (result.phase === 'publish') {
    switch (result.step) {
      case 'stage_and_commit_if_needed':
        return `Could not create the local commit on ${plan.publish.branch}: ${result.message}`;
      case 'sync_branch_with_remote':
        return `Could not sync ${plan.publish.branch} with origin/${plan.publish.branch} before push: ${result.message}`;
      case 'push_branch':
        return `Could not push ${plan.publish.branch} to origin/${plan.publish.branch}: ${result.message}`;
    }
  }

  switch (result.step) {
    case 'ensure_target_branch':
      return `Committed and pushed to ${plan.publish.branch}, but could not prepare ${plan.finalize.targetBranch}: ${result.message}`;
    case 'merge_branch_into_target':
      return `Committed and pushed to ${plan.publish.branch}, but could not merge it into ${plan.finalize.targetBranch}: ${result.message}`;
    case 'merge_target_into_base':
      return (
        `Committed and merged ${plan.finalize.branch} -> ${plan.finalize.targetBranch}, ` +
        `but could not merge ${plan.finalize.targetBranch} into ${plan.finalize.baseBranch}: ${result.message}`
      );
    case 'close_issue':
      return `Committed and merged ${result.mergePath ?? `${plan.finalize.branch} -> ${plan.finalize.targetBranch}`}, but failed to close issue #${plan.finalize.issueNumber}: ${result.message}`;
    case 'lookup_existing_pr':
      return `Committed and pushed to ${plan.publish.branch}, but could not check for an existing PR: ${result.message}`;
    case 'create_pr':
      return `Committed and pushed to ${plan.publish.branch}, but PR creation failed: ${result.message}`;
    case 'mark_in_review': {
      const prVerb = result.existingPr ? 'updated' : 'created';
      const prRef = result.prUrl ? ` (${result.prUrl})` : '';
      return `PR ${prVerb}${prRef}, but failed to mark task #${plan.finalize.issueNumber} as in-review: ${result.message}`;
    }
  }
}

export const definition = {
  type: 'function',
  function: {
    name: 'submit',
    description:
      'Submit a task: choose one of your assigned tasks, prepare the correct task branch, ' +
      'review changes, then commit and create or update the PR. Equivalent to /submit.',
    parameters: {
      type: 'object',
      properties: {
        issue_number: { type: 'number', description: 'Task number to submit. Defaults to the task inferred from the current branch.' },
        commit_message: { type: 'string', description: 'Commit message (optional - defaults to "complete: {task title}").' },
        carry_current_work: {
          type: 'boolean',
          description: 'When submitting a different task from the current branch, bring your current branch work to that task before submitting.',
        },
      },
      required: [],
    },
  },
} as const;

export async function run(_input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const currentBranch = await getCurrentBranch();
  const previousTaskState = getConfig().taskState;
  const [username, currentIssueNumber] = await Promise.all([
    getAuthenticatedUser(config),
    resolveIssueNumberFromBranch(config, currentBranch),
  ]);

  let selectedTask: GitHubIssue | null;
  try {
    selectedTask = await chooseTaskForSubmit(config, username, currentIssueNumber);
  } catch (err) {
    return (err as Error).message;
  }
  if (!selectedTask) {
    return `No claimed or changes-needed tasks assigned to @${username}.`;
  }

  let branch: string;
  let notices: string[];
  let restore: TaskTransitionRestoreContext | undefined;
  try {
    const { context: repoContext, decision, plan, planSource } = await recommendTaskTransition(
      config,
      selectedTask,
      currentBranch,
      getTaskBranch(selectedTask, username),
      previousTaskState,
      undefined,
      {},
      'submit',
    );

    if (shouldConfirmPlannerTransition(repoContext, decision)) {
      try {
        const proceed = await select({
          message:
            `Planner wants to ${decision.action} before submit ` +
            `(${decision.source}, ${decision.confidence}) - ${decision.reason}\n` +
            `Plan: ${summarizeTaskTransitionPlan(plan)}\n` +
            'Continue?',
          choices: [
            { name: `Continue with ${decision.action}`, value: true },
            { name: 'Cancel', value: false },
          ],
        });
        if (!proceed) return 'Submit cancelled.';
      } catch {
        return 'Submit cancelled.';
      }
    }

    ({ branch, notices, restore } = await applyTaskTransition(selectedTask, plan));
    notices = [
      formatPlannerNotice(decision, 'recommended'),
      `Plan (${planSource}): ${summarizeTaskTransitionPlan(plan)}`,
      ...notices,
    ];
  } catch (err) {
    return (err as Error).message;
  }

  const outcome = await performSubmit(config, selectedTask, branch, username, true);
  let allNotices = notices;
  if (outcome.success) {
    allNotices = notices.concat(await finalizePostSubmitContext(config, selectedTask.number, branch, restore));
  }

  return formatSubmitResult(outcome.message, allNotices);
}

export async function execute(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const currentBranch = await getCurrentBranch();
  const previousTaskState = getConfig().taskState;
  const username = await getAuthenticatedUser(config);
  const requestedIssueNumber = input['issue_number'] as number | undefined;
  const carryCurrentWork = input['carry_current_work'] as boolean | undefined;

  const issueNumber = requestedIssueNumber ?? await resolveIssueNumberFromBranch(config, currentBranch);
  if (!issueNumber) {
    return 'No active task found. Specify issue_number or switch to a task branch first.';
  }

  const issue = await getTask(config, issueNumber);
  if (!isSubmittableTask(issue)) {
    return `Task #${issue.number} is not in a submittable state (${getStatus(issue)}).`;
  }
  if (issue.assignee !== username) {
    return issue.assignee
      ? `Task #${issue.number} is assigned to @${issue.assignee}, not @${username}.`
      : `Task #${issue.number} is not assigned to @${username}.`;
  }

  let branch: string;
  let notices: string[];
  let restore: TaskTransitionRestoreContext | undefined;
  try {
    const { decision, plan, planSource } = await recommendTaskTransition(
      config,
      issue,
      currentBranch,
      getTaskBranch(issue, username),
      previousTaskState,
      carryCurrentWork ? 'carry' : undefined,
      {},
      'submit',
    );
    ({ branch, notices, restore } = await applyTaskTransition(issue, plan));
    notices = [
      formatPlannerNotice(decision, 'chose'),
      `Plan (${planSource}): ${summarizeTaskTransitionPlan(plan)}`,
      ...notices,
    ];
  } catch (err) {
    return (err as Error).message;
  }

  const outcome = await performSubmit(
    config,
    issue,
    branch,
    username,
    false,
    input['commit_message'] as string | undefined,
  );
  let allNotices = notices;
  if (outcome.success) {
    allNotices = notices.concat(await finalizePostSubmitContext(config, issue.number, branch, restore));
  }

  return formatSubmitResult(outcome.message, allNotices);
}

export const terminal = true;
