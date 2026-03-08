import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import ora from 'ora';
import type { TechunterConfig } from '../../types.js';
import { getAuthenticatedUser, listTasksForReview, acceptTask } from '../../lib/github.js';

export const definition = {
  type: 'function',
  function: {
    name: 'accept',
    description:
      'Accept an in-review task: merges the PR into the configured base branch and closes the issue.',
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

  const baseBranch = config.github.baseBranch ?? 'main';

  let confirmed: boolean;
  try {
    confirmed = await select({
      message: `Merge PR for #${issueNumber} into ${chalk.cyan(baseBranch)} and close issue?`,
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
  try {
    const result = await acceptTask(config, issueNumber);
    spinner.succeed(`PR #${result.prNumber} merged into ${baseBranch}`);

    return `Task #${issueNumber} accepted.\nPR #${result.prNumber} merged → ${baseBranch}\nIssue closed.`;
  } catch (err) {
    spinner.fail('Failed');
    return `Error: ${(err as Error).message}`;
  }
}

export async function execute(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const issueNumber = input['issue_number'] as number;
  const spinner = ora(`Merging PR for #${issueNumber}…`).start();
  try {
    const result = await acceptTask(config, issueNumber);
    spinner.stop();
    const baseBranch = config.github.baseBranch ?? 'main';
    return `Task #${issueNumber} accepted.\nPR #${result.prNumber} merged → ${baseBranch}\nIssue closed.`;
  } catch (err) {
    spinner.stop();
    return `Error: ${(err as Error).message}`;
  }
}
export const terminal = true;
