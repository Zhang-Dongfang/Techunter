import chalk from 'chalk';
import ora from 'ora';
import { select } from '@inquirer/prompts';
import type { GitHubIssue, TaskTransitionPlanOptions, TechunterConfig, TaskState } from '../../types.js';
import {
  claimTask,
  getAuthenticatedUser,
  getTask,
  listComments,
  listTasks,
} from '../../lib/github.js';
import {
  getCurrentBranch,
  getCurrentCommit,
  makeTaskBranchName,
  pushBranch,
} from '../../lib/git.js';
import { extractBaseCommit } from '../../lib/github.js';
import { getConfig, setConfig } from '../../lib/config.js';
import { getStatus, colorStatus, printTaskDetail } from '../../lib/display.js';
import { launchClaudeCode } from '../../lib/launch.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { formatPlannerNotice, recommendTaskTransition } from '../../lib/task-orchestrator.js';
import { applyTaskTransition, summarizeTaskTransitionPlan } from '../../lib/task-transition.js';
import { run as runClose } from '../close/index.js';
import { run as runSubmit } from '../submit/index.js';

export const definition = {
  type: 'function',
  function: {
    name: 'pick',
    description:
      'Browse the task list and act on a specific task (claim, switch-fix, submit, close, or view). ' +
      'Equivalent to /pick. Use when the user wants to explore or take action on a task.',
    parameters: {
      type: 'object',
      properties: {
        issue_number: { type: 'number', description: 'Issue number to act on.' },
        action: {
          type: 'string',
          enum: ['claim', 'view', 'switch-fix', 'submit', 'close'],
          description:
            '"claim" to assign yourself and create a branch; "switch-fix" to enter a changes-needed task branch; ' +
            '"submit"/"close" to delegate to those tools; "view" to return task details.',
        },
      },
      required: ['issue_number', 'action'],
    },
  },
} as const;

function formatNotices(notices: string[]): string {
  return notices.length > 0 ? `${notices.map((notice) => `Note: ${notice}`).join('\n')}\n\n` : '';
}

function buildResumeStack(previousTaskState: TaskState | undefined, transition: Awaited<ReturnType<typeof applyTaskTransition>>): TaskState['resumeStack'] {
  const existing = previousTaskState?.resumeStack ?? [];
  if (!transition.deferredRestore) {
    return existing.length > 0 ? existing : undefined;
  }

  return [
    ...existing,
    {
      originalBranch: transition.deferredRestore.originalBranch,
      restoreStash: transition.deferredRestore.restoreStash,
      taskStateSnapshot: previousTaskState
        ? {
          activeIssueNumber: previousTaskState.activeIssueNumber,
          baseCommit: previousTaskState.baseCommit,
          activeBranch: previousTaskState.activeBranch,
        }
        : undefined,
    },
  ];
}

async function transitionToTaskContext(
  config: TechunterConfig,
  issue: GitHubIssue,
  taskBranch: string,
  goal: 'claim' | 'switch-fix',
  options: TaskTransitionPlanOptions = {},
): Promise<{ baseCommit: string; notices: string[] }> {
  const previousTaskState = getConfig().taskState;
  const currentBranch = await getCurrentBranch();
  const { decision, plan, planSource } = await recommendTaskTransition(
    config,
    issue,
    currentBranch,
    taskBranch,
    previousTaskState,
    'switch',
    options,
    goal,
  );
  const transition = await applyTaskTransition(issue, plan);
  const notices = [
    formatPlannerNotice(decision, 'chose'),
    `Plan (${planSource}): ${summarizeTaskTransitionPlan(plan)}`,
    ...transition.notices,
  ];

  if (transition.restore?.restoreStash) {
    notices.push(`Your previous work was stashed and remains on ${transition.restore.originalBranch} until you restore it.`);
  }

  const baseCommit = extractBaseCommit(issue.body) ?? await getCurrentCommit();
  setConfig({
    taskState: {
      activeIssueNumber: issue.number,
      baseCommit,
      activeBranch: taskBranch,
      resumeStack: buildResumeStack(previousTaskState, transition),
    },
  });
  return { baseCommit, notices };
}

async function claimAndSwitchTask(
  config: TechunterConfig,
  issue: GitHubIssue,
  username: string,
): Promise<{ baseCommit: string; notices: string[]; taskBranch: string }> {
  await claimTask(config, issue.number, username);
  const taskBranch = makeTaskBranchName(issue.number, username);
  const { baseCommit, notices } = await transitionToTaskContext(
    config,
    issue,
    taskBranch,
    'claim',
    { returnToOriginalBranch: false, restoreStashOnTarget: false },
  );
  try {
    await pushBranch(taskBranch);
  } catch {
    notices.push(`Could not push ${taskBranch} yet. It will be pushed on submit.`);
  }
  return { baseCommit, notices, taskBranch };
}

async function switchToFixTask(
  config: TechunterConfig,
  issue: GitHubIssue,
  username: string,
): Promise<{ baseCommit: string; notices: string[]; taskBranch: string }> {
  const taskBranch = issue.assignee
    ? makeTaskBranchName(issue.number, issue.assignee)
    : makeTaskBranchName(issue.number, username);
  const { baseCommit, notices } = await transitionToTaskContext(
    config,
    issue,
    taskBranch,
    'switch-fix',
    { returnToOriginalBranch: false, restoreStashOnTarget: false },
  );
  return { baseCommit, notices, taskBranch };
}

export async function run(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const preselected = input['issue_number'] as number | undefined;
  let chosenNumber: number;

  if (preselected !== undefined) {
    chosenNumber = preselected;
  } else {
    let tasks;
    try {
      tasks = await listTasks(config);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
    if (tasks.length === 0) return 'No tasks found.';
    try {
      chosenNumber = await select({
        message: 'Select a task:',
        choices: tasks.map((task) => ({
          name: `#${String(task.number).padEnd(4)} ${colorStatus(getStatus(task))} ${task.title}`,
          value: task.number,
        })),
      });
    } catch {
      return 'Cancelled.';
    }
  }

  let issue;
  try {
    issue = await getTask(config, chosenNumber);
  } catch (err) {
    return `Error loading task: ${(err as Error).message}`;
  }

  printTaskDetail(issue);

  const status = getStatus(issue);
  if (status === 'changes-needed') {
    try {
      const comments = await listComments(config, issue.number, 1);
      if (comments.length > 0) {
        const comment = comments[0];
        const divider = chalk.dim('-'.repeat(70));
        console.log(
          chalk.red.bold('  Latest rejection feedback') +
          chalk.dim(` - @${comment.author} - ${comment.createdAt.slice(0, 10)}`),
        );
        console.log(divider);
        console.log(renderMarkdown(comment.body));
        console.log(divider + '\n');
      }
    } catch {
      // Ignore comment rendering failures.
    }
  }

  const actions: { name: string; value: string }[] = [];
  if (status === 'available') {
    actions.push({ name: 'Claim this task', value: 'claim' });
  }
  if (status === 'claimed') {
    actions.push({ name: 'Submit this task', value: 'submit' });
  }
  if (status === 'changes-needed') {
    const username = await getAuthenticatedUser(config);
    const taskBranch = issue.assignee
      ? makeTaskBranchName(issue.number, issue.assignee)
      : makeTaskBranchName(issue.number, username);
    const currentBranch = await getCurrentBranch();
    if (currentBranch === taskBranch) {
      actions.push({ name: 'Submit this task (fixes done)', value: 'submit' });
    } else {
      actions.push({ name: `Switch to ${taskBranch} to fix`, value: 'switch-fix' });
    }
  }
  actions.push({ name: 'Close this task', value: 'close' });
  actions.push({ name: 'Nothing, just viewing', value: 'none' });

  let action: string;
  try {
    action = await select({ message: 'Action:', choices: actions });
  } catch {
    return 'Cancelled.';
  }

  if (action === 'none') return `Viewed task #${issue.number}.`;
  if (action === 'submit') return runSubmit({ issue_number: issue.number }, config);
  if (action === 'close') return runClose({ issue_number: issue.number }, config);

  if (action === 'claim') {
    let spinner: ReturnType<typeof ora> | undefined;
    try {
      const username = await getAuthenticatedUser(config);
      spinner = ora(`Claiming #${issue.number}...`).start();
      const { baseCommit, notices, taskBranch } = await claimAndSwitchTask(config, issue, username);
      spinner.stop();
      console.log(chalk.green(`\n  Claimed! Branch: ${taskBranch}  (base: ${baseCommit.slice(0, 7)})\n`));

      let openClaude = false;
      try {
        openClaude = await select({
          message: 'Open Claude Code for this task?',
          choices: [
            { name: 'Yes, start coding now', value: true },
            { name: 'No, return to tch', value: false },
          ],
        });
      } catch {
        openClaude = false;
      }
      if (openClaude) await launchClaudeCode(issue, taskBranch);
      return `${formatNotices(notices)}Task #${issue.number} claimed. Branch: ${taskBranch}`;
    } catch (err) {
      spinner?.stop();
      return `Error claiming task: ${(err as Error).message}`;
    }
  }

  if (action === 'switch-fix') {
    let spinner: ReturnType<typeof ora> | undefined;
    try {
      const username = await getAuthenticatedUser(config);
      const taskBranch = issue.assignee
        ? makeTaskBranchName(issue.number, issue.assignee)
        : makeTaskBranchName(issue.number, username);
      spinner = ora(`Switching to ${taskBranch}...`).start();
      const { notices } = await switchToFixTask(config, issue, username);
      spinner.stop();
      console.log(chalk.green(`\n  Switched to ${taskBranch}. Fix the issues then run /submit.\n`));
      return `${formatNotices(notices)}Switched to ${taskBranch} for task #${issue.number}.`;
    } catch (err) {
      spinner?.stop();
      return `Error: ${(err as Error).message}`;
    }
  }

  return 'Cancelled.';
}

export async function execute(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const issueNumber = input['issue_number'] as number;
  const action = input['action'] as string;

  let issue;
  try {
    issue = await getTask(config, issueNumber);
  } catch (err) {
    return `Error loading task: ${(err as Error).message}`;
  }

  if (action === 'view') {
    const status = getStatus(issue);
    const assignee = issue.assignee ? `@${issue.assignee}` : '-';
    return [`#${issue.number}  [${status}]  ${assignee}  ${issue.title}`, issue.body ?? ''].join('\n\n');
  }

  if (action === 'submit') return runSubmit({ issue_number: issue.number }, config);
  if (action === 'close') return runClose({ issue_number: issue.number }, config);

  if (action === 'claim') {
    const username = await getAuthenticatedUser(config);
    const status = getStatus(issue);
    if (status !== 'available') {
      return `Task #${issueNumber} is not available to claim (current status: ${status}).`;
    }

    try {
      const { baseCommit, notices, taskBranch } = await claimAndSwitchTask(config, issue, username);
      return `${formatNotices(notices)}Task #${issueNumber} claimed. Branch: ${taskBranch} (base commit: ${baseCommit.slice(0, 7)})`;
    } catch (err) {
      return `Error claiming task: ${(err as Error).message}`;
    }
  }

  if (action === 'switch-fix') {
    const status = getStatus(issue);
    if (status !== 'changes-needed') {
      return `Task #${issueNumber} is not in changes-needed (current status: ${status}).`;
    }

    try {
      const username = await getAuthenticatedUser(config);
      const { notices, taskBranch } = await switchToFixTask(config, issue, username);
      return `${formatNotices(notices)}Switched to ${taskBranch} for task #${issue.number}.`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  }

  return `Unknown action: ${action}`;
}

export const terminal = true;
