import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import ora from 'ora';
import type { TechunterConfig } from '../../types.js';
import { getAuthenticatedUser, listTasksForReview, acceptTask, getTask, mergeWorkerIntoBase } from '../../lib/github.js';
import { makeWorkerBranchName } from '../../lib/git.js';


export const definition = {
  type: 'function',
  function: {
    name: 'accept',
    description:
      'Accept an in-review task: merges the PR into your worker branch and closes the issue.',
    parameters: {
      type: 'object',
      properties: {
        issue_number: { type: 'number', description: 'GitHub issue number to accept' },
      },
      required: ['issue_number'],
    },
  },
} as const;

export async function run(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  let issueNumber = input['issue_number'] as number | undefined;

  if (!issueNumber) {
    const spinner = ora('Loading tasks for review…').start();
    let tasks;
    let me: string;
    try {
      me = await getAuthenticatedUser(config);
      tasks = await listTasksForReview(config, me);
      spinner.stop();
    } catch (err) {
      spinner.stop();
      return `Error: ${(err as Error).message}`;
    }

    if (tasks.length === 0) return 'No tasks pending review.';

    try {
      issueNumber = await select({
        message: 'Which task to accept?',
        choices: tasks.map((t) => ({
          name: `#${t.number}  @${t.assignee ?? '—'}  ${t.title}`,
          value: t.number,
        })),
      });
    } catch {
      return 'Cancelled.';
    }
  }

  const spinner2 = ora('Verifying permissions…').start();
  let me2: string;
  let issue: Awaited<ReturnType<typeof getTask>>;
  try {
    [me2, issue] = await Promise.all([
      getAuthenticatedUser(config),
      getTask(config, issueNumber),
    ]);
    spinner2.stop();
  } catch (err) {
    spinner2.stop();
    return `Error: ${(err as Error).message}`;
  }
  if (issue.author && issue.author !== me2) {
    return `Permission denied: only the task author (@${issue.author}) can accept task #${issueNumber}.`;
  }

  const targetBranch = makeWorkerBranchName(me2);

  let confirmed: boolean;
  try {
    confirmed = await select({
      message: `Merge PR for #${issueNumber} into ${chalk.cyan(targetBranch)} and close issue?`,
      choices: [
        { name: 'Yes, accept', value: true },
        { name: 'Cancel', value: false },
      ],
    });
  } catch {
    return 'Cancelled.';
  }
  if (!confirmed) return 'Cancelled.';

  const spinner = ora(`Merging PR for #${issueNumber}…`).start();
  let result: Awaited<ReturnType<typeof acceptTask>>;
  try {
    const assigneeWorkerBranch = issue.assignee ? makeWorkerBranchName(issue.assignee) : undefined;
    result = await acceptTask(config, issueNumber, assigneeWorkerBranch);
    spinner.succeed(`PR #${result.prNumber} merged into ${targetBranch}`);
  } catch (err) {
    spinner.fail('Failed');
    return `Error: ${(err as Error).message}`;
  }

  const baseBranch = config.baseBranch ?? 'main';
  let pushToMain: boolean;
  try {
    pushToMain = await select({
      message: `Push ${chalk.cyan(targetBranch)} → ${chalk.cyan(baseBranch)}?`,
      choices: [
        { name: `Yes, push to ${baseBranch}`, value: true },
        { name: 'No, keep in worker branch', value: false },
      ],
    });
  } catch { pushToMain = false; }

  if (pushToMain) {
    const mergeSpinner = ora(`Merging ${targetBranch} → ${baseBranch}…`).start();
    try {
      await mergeWorkerIntoBase(config, targetBranch, baseBranch);
      mergeSpinner.succeed(`Merged ${targetBranch} → ${baseBranch}`);
    } catch (err) {
      mergeSpinner.fail(`Could not merge to ${baseBranch}: ${(err as Error).message}`);
    }
  }

  return `Task #${issueNumber} accepted.\nPR #${result.prNumber} merged → ${targetBranch}${pushToMain ? ` → ${baseBranch}` : ''}\nIssue closed.`;
}

export async function execute(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const issueNumber = input['issue_number'] as number;
  const [me, issue] = await Promise.all([
    getAuthenticatedUser(config),
    getTask(config, issueNumber),
  ]);
  if (issue.author && issue.author !== me) {
    return `Permission denied: only the task author (@${issue.author}) can accept task #${issueNumber}.`;
  }

  const targetBranch = makeWorkerBranchName(me);
  const spinner = ora(`Merging PR for #${issueNumber}…`).start();
  try {
    const assigneeWorkerBranch = issue.assignee ? makeWorkerBranchName(issue.assignee) : undefined;
    const result = await acceptTask(config, issueNumber, assigneeWorkerBranch);
    spinner.stop();
    return `Task #${issueNumber} accepted.\nPR #${result.prNumber} merged → ${targetBranch}\nIssue closed.`;
  } catch (err) {
    spinner.stop();
    return `Error: ${(err as Error).message}`;
  }
}
export const terminal = true;
