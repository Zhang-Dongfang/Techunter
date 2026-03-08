import chalk from 'chalk';
import ora from 'ora';
import { select, input as promptInput } from '@inquirer/prompts';
import type { TechunterConfig } from '../../types.js';
import { getTask, createPR, markInReview, getBaseBranch } from '../../lib/github.js';
import { getCurrentBranch, getDiff, stageAllAndCommit } from '../../lib/git.js';
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

export async function run(config: TechunterConfig): Promise<string> {
  const branch = await getCurrentBranch();
  const match = branch.match(/^task-(\d+)-/);
  if (!match) {
    return `Not on a task branch (current: ${branch}). Expected format: task-N-title.`;
  }
  const issueNumber = parseInt(match[1], 10);

  let spinner = ora('Loading task and diff…').start();
  const [issue, defaultBranch, diff] = await Promise.all([
    getTask(config, issueNumber),
    getBaseBranch(config),
    getDiff(),
  ]);
  spinner.stop();

  // AI review with tool access
  const reviewSpinner = ora('Reviewing changes…').start();
  let review = '';
  try {
    review = await reviewChanges(config, issueNumber, issue, diff);
  } catch (err) {
    review = `(Review failed: ${(err as Error).message})`;
  }
  reviewSpinner.stop();

  const divider = chalk.dim('─'.repeat(70));
  console.log('\n' + divider);
  console.log(chalk.bold(`  Review — task #${issueNumber} "${issue.title}"`));
  console.log(divider);
  console.log(renderMarkdown(review));
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

  spinner = ora('Creating pull request…').start();
  let prUrl: string;
  try {
    prUrl = await createPR(
      config,
      issue.title,
      `Closes #${issueNumber}\n\n${issue.body ?? ''}`.trim(),
      branch,
      defaultBranch
    );
    spinner.stop();
  } catch (err) {
    spinner.stop();
    return `Committed but PR creation failed: ${(err as Error).message}`;
  }

  spinner = ora('Marking as in-review…').start();
  try {
    await markInReview(config, issueNumber);
    spinner.stop();
  } catch (err) {
    spinner.stop();
    return `PR created (${prUrl}) but failed to update label: ${(err as Error).message}`;
  }

  return `Task #${issueNumber} submitted.\nCommit: "${commitMessage.trim()}"\nPR: ${prUrl}`;
}

export async function execute(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const branch = await getCurrentBranch();
  const match = branch.match(/^task-(\d+)-/);
  if (!match) return `Not on a task branch (current: ${branch}). Expected format: task-N-title.`;
  const issueNumber = parseInt(match[1], 10);

  const [issue, defaultBranch, diff] = await Promise.all([
    getTask(config, issueNumber),
    getBaseBranch(config),
    getDiff(),
  ]);

  let review = '';
  try {
    review = await reviewChanges(config, issueNumber, issue, diff);
  } catch (err) {
    review = `(Review failed: ${(err as Error).message})`;
  }

  const commitMessage = ((input['commit_message'] as string | undefined)?.trim()) || `complete: ${issue.title}`;

  try {
    await stageAllAndCommit(commitMessage);
  } catch (err) {
    return `Commit failed: ${(err as Error).message}`;
  }

  let prUrl: string;
  try {
    prUrl = await createPR(
      config,
      issue.title,
      `Closes #${issueNumber}\n\n${issue.body ?? ''}`.trim(),
      branch,
      defaultBranch,
    );
  } catch (err) {
    return `Committed but PR creation failed: ${(err as Error).message}`;
  }

  try {
    await markInReview(config, issueNumber);
  } catch { /* label update is non-critical */ }

  return `Task #${issueNumber} submitted.\nReview:\n${review}\nCommit: "${commitMessage}"\nPR: ${prUrl}`;
}
export const terminal = true;
