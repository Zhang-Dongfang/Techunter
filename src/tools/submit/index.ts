import chalk from 'chalk';
import ora from 'ora';
import { select, input as promptInput } from '@inquirer/prompts';
import type { TechunterConfig, GitHubIssue } from '../../types.js';
import {
  getTask,
  createPR,
  markInReview,
  closeTask,
  getAuthenticatedUser,
  ensureRemoteBranch,
  getTaskPR,
  getIssueNumberFromBranch,
  extractTargetBranch,
  getOpenSubtasks,
  listMyTasks,
  extractBaseCommit,
  mergeBranchIntoBase,
} from '../../lib/github.js';
import {
  getCurrentBranch,
  getDiff,
  getDiffFromCommit,
  stageAllAndCommit,
  makeWorkerBranchName,
  parseIssueNumberFromBranch,
  makeTaskBranchName,
  checkoutFromCommit,
  switchToBranchOrCreate,
  hasUncommittedChanges,
  stash,
  stashPop,
  hasCommitsNotInBranch,
  squashMergeBranch,
  resolveBranchRef,
  abortMergeOperation,
  isTaskBranch,
} from '../../lib/git.js';
import { getConfig, setConfig } from '../../lib/config.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { reviewChanges } from './reviewer.js';
import { getStatus } from '../../lib/display.js';

const SUBMITTABLE_LABELS = new Set(['techunter:claimed', 'techunter:changes-needed']);

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
  return issue.assignee
    ? makeTaskBranchName(issue.number, issue.assignee)
    : makeTaskBranchName(issue.number, username);
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

async function switchToTaskBranch(issue: GitHubIssue, username: string): Promise<string> {
  const taskBranch = getTaskBranch(issue, username);
  const taskBase = extractBaseCommit(issue.body);

  if (taskBase) {
    await checkoutFromCommit(taskBranch, taskBase);
  } else {
    const branchRef = await resolveBranchRef(taskBranch);
    if (!branchRef) {
      throw new Error(`Task branch ${taskBranch} does not exist yet. Claim or recreate the task branch first.`);
    }
    await switchToBranchOrCreate(taskBranch);
  }

  await setActiveTaskState(issue, taskBranch);
  return taskBranch;
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

async function prepareTaskContext(
  config: TechunterConfig,
  issue: GitHubIssue,
  username: string,
  currentBranch: string,
  interactive: boolean,
  carryCurrentWork?: boolean,
): Promise<{ branch: string; notices: string[] }> {
  const targetBranch = getTaskBranch(issue, username);
  if (currentBranch === targetBranch) {
    await setActiveTaskState(issue, targetBranch);
    return { branch: targetBranch, notices: [] };
  }

  const hasWorkingTreeChanges = await hasUncommittedChanges();
  const targetCompareRef = (await resolveBranchRef(targetBranch)) ?? targetBranch;
  let hasSourceOnlyCommits = false;
  try {
    hasSourceOnlyCommits = await hasCommitsNotInBranch(currentBranch, targetCompareRef);
  } catch {
    hasSourceOnlyCommits = false;
  }

  let action: 'switch' | 'carry' = 'switch';
  if (hasWorkingTreeChanges || hasSourceOnlyCommits) {
    if (interactive) {
      let choice: 'switch' | 'carry' | 'cancel';
      try {
        choice = await select({
          message: `You are on ${currentBranch}. How should Techunter prepare #${issue.number}?`,
          choices: [
            {
              name: `Switch to #${issue.number} and submit only that task's current work`,
              value: 'switch',
            },
            {
              name: `Bring my current work to #${issue.number} and submit`,
              value: 'carry',
            },
            { name: 'Cancel', value: 'cancel' },
          ],
        });
      } catch {
        throw new Error('Submit cancelled.');
      }
      if (choice === 'cancel') throw new Error('Submit cancelled.');
      action = choice;
    } else if (carryCurrentWork) {
      action = 'carry';
    }
  }

  const notices: string[] = [];
  let stashed = false;
  let switched = false;
  let switchedBranch = targetBranch;
  let mergeAttempted = false;
  let stashRestoredOnTarget = false;

  try {
    if (hasWorkingTreeChanges) {
      await stash(`tch: before submit #${issue.number} from ${currentBranch}`);
      stashed = true;
    }

    switchedBranch = await switchToTaskBranch(issue, username);
    switched = true;

    if (action === 'carry' && hasSourceOnlyCommits) {
      mergeAttempted = true;
      await squashMergeBranch(currentBranch);
      notices.push(`Brought committed work from ${currentBranch} into ${switchedBranch}.`);
    }

    if (action === 'carry' && stashed) {
      await stashPop();
      stashRestoredOnTarget = true;
      notices.push(`Restored your unsaved work on ${switchedBranch}.`);
    } else if (stashed) {
      notices.push(
        `Saved your unsaved work from ${currentBranch}. Return there later and run \`git stash pop\` to restore it.`
      );
    }

    return { branch: switchedBranch, notices };
  } catch (err) {
    const rollbackNotices: string[] = [];

    if (mergeAttempted) {
      await abortMergeOperation();
    }

    if (switched) {
      try {
        await switchToBranchOrCreate(currentBranch);
        rollbackNotices.push(`Returned to ${currentBranch}.`);
      } catch (rollbackErr) {
        rollbackNotices.push(
          `Could not return to ${currentBranch} automatically: ${(rollbackErr as Error).message}`
        );
      }
    }

    if (stashed && !stashRestoredOnTarget) {
      try {
        await stashPop();
        rollbackNotices.push(`Restored your unsaved work on ${currentBranch}.`);
      } catch (stashErr) {
        rollbackNotices.push(
          `Could not restore your unsaved work automatically: ${(stashErr as Error).message}`
        );
      }
    }

    const details = rollbackNotices.length > 0 ? `\n${rollbackNotices.join('\n')}` : '';
    throw new Error(`Could not prepare task #${issue.number}: ${(err as Error).message}${details}`);
  }
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
): Promise<string> {
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
    return interactive
      ? (
        `Cannot submit: ${openSubtaskNumbers.length} sub-task(s) still open:\n` +
        openSubtaskNumbers.map((n) => `  - #${n}`).join('\n') +
        '\nComplete all sub-tasks before submitting.'
      )
      : (
        `Cannot submit: ${openSubtaskNumbers.length} sub-task(s) still open: ` +
        openSubtaskNumbers.map((n) => `#${n}`).join(', ')
      );
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
      return 'Submit cancelled.';
    }
    if (!shouldProceed) return 'Submit cancelled by user.';
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
        return 'Submit cancelled.';
      }
      if (!commitMessage.trim()) return 'Submit cancelled.';
    } else {
      commitMessage = `complete: ${issue.title}`;
    }
  }

  spinner = interactive ? ora('Committing and pushing...').start() : undefined;
  try {
    await stageAllAndCommit(commitMessage.trim());
    spinner?.stop();
  } catch (err) {
    spinner?.stop();
    return `Commit failed: ${(err as Error).message}`;
  }

  if (isSelfSubmit) {
    const baseBranch = config.baseBranch ?? 'main';
    let finalBranch = targetBranch;

    if (branch !== targetBranch) {
      spinner = interactive ? ora(`Merging ${branch} into ${targetBranch}...`).start() : undefined;
      try {
        await ensureRemoteBranch(config, targetBranch, baseBranch);
        await mergeBranchIntoBase(config, branch, targetBranch);
        spinner?.stop();
      } catch (err) {
        spinner?.stop();
        return `Committed and pushed to ${branch}, but failed to merge into ${targetBranch}: ${(err as Error).message}`;
      }
    }

    if (!isTaskBranch(targetBranch) && targetBranch !== baseBranch) {
      spinner = interactive ? ora(`Merging ${targetBranch} into ${baseBranch}...`).start() : undefined;
      try {
        await mergeBranchIntoBase(config, targetBranch, baseBranch);
        finalBranch = baseBranch;
        spinner?.stop();
      } catch (err) {
        spinner?.stop();
        return `Committed and merged ${branch} -> ${targetBranch}, but failed to merge ${targetBranch} into ${baseBranch}: ${(err as Error).message}`;
      }
    }

    spinner = interactive ? ora('Closing issue...').start() : undefined;
    try {
      await closeTask(config, issue.number);
      spinner?.stop();
    } catch (err) {
      spinner?.stop();
      if (interactive) {
        console.error(chalk.yellow(`Warning: failed to close issue: ${(err as Error).message}`));
      }
    }
    setConfig({ taskState: { activeIssueNumber: undefined, baseCommit: undefined, activeBranch: undefined } });
    const mergePath = finalBranch === targetBranch
      ? `${branch} -> ${targetBranch}`
      : `${branch} -> ${targetBranch} -> ${finalBranch}`;
    return `Task #${issue.number} committed and closed.\nMerged: ${mergePath}\nCommit: "${commitMessage.trim()}"`;
  }

  spinner = interactive ? ora('Checking for existing PR...').start() : undefined;
  const existingPR = await getTaskPR(config, issue.number, branch);
  spinner?.stop();

  let prUrl: string;
  if (existingPR) {
    prUrl = existingPR.url;
    if (interactive) {
      console.log(chalk.dim(`  Existing PR found: ${prUrl} - updating.`));
    }
  } else {
    spinner = interactive ? ora('Creating pull request...').start() : undefined;
    try {
      await ensureRemoteBranch(config, targetBranch, config.baseBranch ?? 'main');
      const prBody = [
        `Closes #${issue.number}`,
        issue.body ? `\n${issue.body}` : '',
        review ? `\n## AI Review\n${review}` : '',
      ].join('\n').trim();
      prUrl = await createPR(config, issue.title, prBody, branch, targetBranch);
      spinner?.stop();
    } catch (err) {
      spinner?.stop();
      return `Committed but PR creation failed: ${(err as Error).message}`;
    }
  }

  spinner = interactive ? ora('Marking as in-review...').start() : undefined;
  try {
    await markInReview(config, issue.number);
    spinner?.stop();
  } catch (err) {
    spinner?.stop();
    return interactive
      ? `PR ${existingPR ? 'updated' : 'created'} (${prUrl}) but failed to update label: ${(err as Error).message}`
      : `PR ${existingPR ? 'updated' : 'created'} (${prUrl}) but failed to update label: ${(err as Error).message}`;
  }

  setConfig({ taskState: { activeIssueNumber: undefined, baseCommit: undefined, activeBranch: undefined } });
  return interactive
    ? `Task #${issue.number} ${existingPR ? 're-submitted' : 'submitted'}.\nCommit: "${commitMessage.trim()}"\nPR: ${prUrl}`
    : `Task #${issue.number} ${existingPR ? 're-submitted' : 'submitted'}.\nReview:\n${review}\nCommit: "${commitMessage.trim()}"\nPR: ${prUrl}`;
}

function formatSubmitResult(result: string, notices: string[]): string {
  if (notices.length === 0) return result;
  return `${notices.map((notice) => `Note: ${notice}`).join('\n')}\n\n${result}`;
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
  try {
    ({ branch, notices } = await prepareTaskContext(config, selectedTask, username, currentBranch, true));
  } catch (err) {
    return (err as Error).message;
  }

  return formatSubmitResult(
    await performSubmit(config, selectedTask, branch, username, true),
    notices,
  );
}

export async function execute(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const currentBranch = await getCurrentBranch();
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
  try {
    ({ branch, notices } = await prepareTaskContext(
      config,
      issue,
      username,
      currentBranch,
      false,
      carryCurrentWork,
    ));
  } catch (err) {
    return (err as Error).message;
  }

  return formatSubmitResult(
    await performSubmit(
      config,
      issue,
      branch,
      username,
      false,
      input['commit_message'] as string | undefined,
    ),
    notices,
  );
}

export const terminal = true;
