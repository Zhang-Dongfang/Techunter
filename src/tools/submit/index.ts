import chalk from 'chalk';
import ora from 'ora';
import { select, input as promptInput } from '@inquirer/prompts';
import type { TechunterConfig } from '../../types.js';
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
} from '../../lib/github.js';
import { getCurrentBranch, getDiff, getDiffFromCommit, stageAllAndCommit, makeWorkerBranchName, parseIssueNumberFromBranch } from '../../lib/git.js';
import { getConfig, setConfig } from '../../lib/config.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { reviewChanges } from './reviewer.js';

export const definition = {
  type: 'function',
  function: {
    name: 'submit',
    description:
      'Submit the current task: reviews changes against acceptance criteria, then commits, creates a PR, ' +
      'and marks the issue as in-review. Equivalent to /submit.',
    parameters: {
      type: 'object',
      properties: {
        commit_message: { type: 'string', description: 'Commit message (optional — defaults to "complete: {task title}").' },
      },
      required: [],
    },
  },
} as const;

export async function run(_input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const taskState = getConfig().taskState;
  const currentBranch = await getCurrentBranch();

  // If current branch doesn't match taskState, ignore taskState and detect from branch
  let issueNumber =
    taskState?.activeIssueNumber &&
    taskState?.activeBranch &&
    currentBranch === taskState.activeBranch
      ? taskState.activeIssueNumber
      : undefined;

  if (!issueNumber) {
    // Try parsing from branch name first (fast, no API call)
    const fromBranch = parseIssueNumberFromBranch(currentBranch);
    if (fromBranch) {
      issueNumber = fromBranch;
    } else {
      // Fall back to PR lookup
      const found = await getIssueNumberFromBranch(config, currentBranch);
      if (!found) {
        return 'No active task found. Claim a task first with /pick.';
      }
      issueNumber = found.issueNumber;
    }
  }

  let spinner = ora('Loading task and diff…').start();
  const diffPromise = taskState?.baseCommit
    ? getDiffFromCommit(taskState.baseCommit)
    : getDiff();
  const [issue, diff, me] = await Promise.all([
    getTask(config, issueNumber),
    diffPromise,
    getAuthenticatedUser(config),
  ]);
  spinner.stop();

  // Determine PR target: from issue body or fall back to task author's worker branch
  const targetBranch = extractTargetBranch(issue.body) ?? makeWorkerBranchName(issue.author ?? me);
  const branch = await getCurrentBranch();

  const isSelfSubmit = issue.author !== null && issue.author === me;

  // Check for open sub-tasks before submitting
  spinner = ora('Checking for open sub-tasks…').start();
  const openSubtaskNumbers = await getOpenSubtasks(config, branch);
  spinner.stop();
  if (openSubtaskNumbers.length > 0) {
    return (
      `Cannot submit: ${openSubtaskNumbers.length} sub-task(s) still open:\n` +
      openSubtaskNumbers.map((n) => `  - #${n}`).join('\n') +
      '\nComplete all sub-tasks before submitting.'
    );
  }

  // AI review (skipped if submitter is the task author)
  let review = '';
  if (!isSelfSubmit) {
    const reviewSpinner = ora('Reviewing changes…').start();
    try {
      review = await reviewChanges(config, issueNumber, issue, diff);
    } catch (err) {
      review = `(Review failed: ${(err as Error).message})`;
    }
    reviewSpinner.stop();
  }

  const divider = chalk.dim('─'.repeat(70));
  console.log('\n' + divider);
  if (isSelfSubmit) {
    console.log(chalk.yellow(`  Self-submit detected — AI review skipped.`));
  } else {
    console.log(chalk.bold(`  Review — task #${issueNumber} "${issue.title}"`));
    console.log(divider);
    console.log(renderMarkdown(review));
  }
  console.log(divider + '\n');

  let shouldProceed: boolean;
  try {
    shouldProceed = await select({
      message: `Submit task #${issueNumber}?`,
      choices: [
        { name: 'Yes, submit', value: true },
        { name: 'No, not ready yet', value: false },
      ],
    });
  } catch {
    return 'Submit cancelled.';
  }
  if (!shouldProceed) return 'Submit cancelled by user.';

  let commitMessage: string;
  try {
    commitMessage = await promptInput({
      message: 'Commit message:',
      default: `complete: ${issue.title}`,
    });
  } catch {
    return 'Submit cancelled.';
  }
  if (!commitMessage.trim()) return 'Submit cancelled.';

  spinner = ora('Committing and pushing…').start();
  try {
    await stageAllAndCommit(commitMessage.trim());
    spinner.stop();
  } catch (err) {
    spinner.stop();
    return `Commit failed: ${(err as Error).message}`;
  }

  if (isSelfSubmit) {
    spinner = ora('Closing issue…').start();
    try {
      await closeTask(config, issueNumber);
      spinner.stop();
    } catch (err) {
      spinner.stop();
      console.error(chalk.yellow(`Warning: failed to close issue: ${(err as Error).message}`));
    }
    setConfig({ taskState: { activeIssueNumber: undefined, baseCommit: undefined, activeBranch: undefined } });
    return `Task #${issueNumber} committed and closed.\nCommit: "${commitMessage.trim()}"`;
  }

  // Check if a PR already exists for this issue (re-submission case)
  spinner = ora('Checking for existing PR…').start();
  const existingPR = await getTaskPR(config, issueNumber);
  spinner.stop();

  let prUrl: string;
  if (existingPR) {
    prUrl = existingPR.url;
    console.log(chalk.dim(`  Existing PR found: ${prUrl} — updating.`));
  } else {
    spinner = ora('Creating pull request…').start();
    try {
      await ensureRemoteBranch(config, targetBranch, config.baseBranch ?? 'main');
      const prBody = [
        `Closes #${issueNumber}`,
        issue.body ? `\n${issue.body}` : '',
        review ? `\n## AI Review\n${review}` : '',
      ].join('\n').trim();
      prUrl = await createPR(config, issue.title, prBody, branch, targetBranch);
      spinner.stop();
    } catch (err) {
      spinner.stop();
      return `Committed but PR creation failed: ${(err as Error).message}`;
    }
  }

  spinner = ora('Marking as in-review…').start();
  try {
    await markInReview(config, issueNumber);
    spinner.stop();
  } catch (err) {
    spinner.stop();
    return `PR ${existingPR ? 'updated' : 'created'} (${prUrl}) but failed to update label: ${(err as Error).message}`;
  }

  setConfig({ taskState: { activeIssueNumber: undefined, baseCommit: undefined, activeBranch: undefined } });
  return `Task #${issueNumber} ${existingPR ? 're-submitted' : 'submitted'}.\nCommit: "${commitMessage.trim()}"\nPR: ${prUrl}`;
}

export async function execute(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const taskState = getConfig().taskState;
  let issueNumber = taskState?.activeIssueNumber;

  if (!issueNumber) {
    const currentBranch = await getCurrentBranch();
    const fromBranch = parseIssueNumberFromBranch(currentBranch);
    if (fromBranch) {
      issueNumber = fromBranch;
    } else {
      const found = await getIssueNumberFromBranch(config, currentBranch);
      if (!found) return 'No active task found. Claim a task first.';
      issueNumber = found.issueNumber;
    }
  }

  const diffPromise = taskState?.baseCommit
    ? getDiffFromCommit(taskState.baseCommit)
    : getDiff();
  const [issue, diff, branch, me] = await Promise.all([
    getTask(config, issueNumber),
    diffPromise,
    getCurrentBranch(),
    getAuthenticatedUser(config),
  ]);

  const targetBranch = extractTargetBranch(issue.body) ?? makeWorkerBranchName(issue.author ?? me);

  // Check open sub-tasks
  const openSubtaskNumbers = await getOpenSubtasks(config, branch);
  if (openSubtaskNumbers.length > 0) {
    return (
      `Cannot submit: ${openSubtaskNumbers.length} sub-task(s) still open: ` +
      openSubtaskNumbers.map((n) => `#${n}`).join(', ')
    );
  }

  const isSelfSubmit = issue.author !== null && issue.author === me;
  let review = '';
  if (!isSelfSubmit) {
    try {
      review = await reviewChanges(config, issueNumber, issue, diff);
    } catch (err) {
      review = `(Review failed: ${(err as Error).message})`;
    }
  }

  const commitMessage = ((input['commit_message'] as string | undefined)?.trim()) || `complete: ${issue.title}`;

  try {
    await stageAllAndCommit(commitMessage);
  } catch (err) {
    return `Commit failed: ${(err as Error).message}`;
  }

  if (isSelfSubmit) {
    try {
      await closeTask(config, issueNumber);
    } catch { /* non-critical */ }
    setConfig({ taskState: { activeIssueNumber: undefined, baseCommit: undefined, activeBranch: undefined } });
    return `Task #${issueNumber} committed and closed.\nCommit: "${commitMessage}"`;
  }

  const existingPR = await getTaskPR(config, issueNumber);

  let prUrl: string;
  if (existingPR) {
    prUrl = existingPR.url;
  } else {
    try {
      await ensureRemoteBranch(config, targetBranch, config.baseBranch ?? 'main');
      const prBody = [
        `Closes #${issueNumber}`,
        issue.body ? `\n${issue.body}` : '',
        review ? `\n## AI Review\n${review}` : '',
      ].join('\n').trim();
      prUrl = await createPR(config, issue.title, prBody, branch, targetBranch);
    } catch (err) {
      return `Committed but PR creation failed: ${(err as Error).message}`;
    }
  }

  try {
    await markInReview(config, issueNumber);
  } catch { /* label update is non-critical */ }

  setConfig({ taskState: { activeIssueNumber: undefined, baseCommit: undefined, activeBranch: undefined } });
  return `Task #${issueNumber} ${existingPR ? 're-submitted' : 'submitted'}.\nReview:\n${review}\nCommit: "${commitMessage}"\nPR: ${prUrl}`;
}
export const terminal = true;
