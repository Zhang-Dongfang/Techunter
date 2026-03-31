import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import ora from 'ora';
import type { TechunterConfig } from '../../types.js';
import { getAuthenticatedUser, listTasksForReview, acceptTask, getTask, mergeWorkerIntoBase, upsertRepoFile } from '../../lib/github.js';
import { isTaskBranch } from '../../lib/git.js';
import { generateWiki } from '../wiki/wiki-generator.js';


export const definition = {
  type: 'function',
  function: {
    name: 'accept',
    description:
      'Accept an in-review task: merges the PR into the target branch and closes the issue.',
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

  let confirmed: boolean;
  try {
    confirmed = await select({
      message: `Merge PR for #${issueNumber} and close issue?`,
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
    result = await acceptTask(config, issueNumber);
    spinner.succeed(`PR #${result.prNumber} merged → ${chalk.cyan(result.baseBranch)}`);
  } catch (err) {
    spinner.fail('Failed');
    return `Error: ${(err as Error).message}`;
  }

  // Only offer push-to-main when PR target is a worker branch (not a task branch)
  const mergedIntoTaskBranch = isTaskBranch(result.baseBranch);
  if (!mergedIntoTaskBranch) {
    const baseBranch = config.baseBranch ?? 'main';
    let pushToMain: boolean;
    try {
      pushToMain = await select({
        message: `Push ${chalk.cyan(result.baseBranch)} → ${chalk.cyan(baseBranch)}?`,
        choices: [
          { name: `Yes, push to ${baseBranch}`, value: true },
          { name: 'No, keep in worker branch', value: false },
        ],
      });
    } catch { pushToMain = false; }

    if (pushToMain) {
      const mergeSpinner = ora(`Merging ${result.baseBranch} → ${baseBranch}…`).start();
      try {
        await mergeWorkerIntoBase(config, result.baseBranch, baseBranch);
        mergeSpinner.succeed(`Merged ${result.baseBranch} → ${baseBranch}`);
      } catch (err) {
        mergeSpinner.fail(`Could not merge to ${baseBranch}: ${(err as Error).message}`);
      }
    }
  }

  let updateWiki = false;
  try {
    updateWiki = await select({
      message: 'Update TECHUNTER.md project overview?',
      choices: [
        { name: 'Yes, regenerate', value: true },
        { name: 'No, skip', value: false },
      ],
    });
  } catch { /* skip */ }

  if (updateWiki) {
    const wikiSpinner = ora('Regenerating TECHUNTER.md…').start();
    try {
      const content = await generateWiki(config);
      await upsertRepoFile(config, 'TECHUNTER.md', content, 'docs: update TECHUNTER.md project overview');
      wikiSpinner.succeed('TECHUNTER.md updated');
    } catch (err) {
      wikiSpinner.fail(`Wiki update failed: ${(err as Error).message}`);
    }
  }

  const mergeTarget = mergedIntoTaskBranch
    ? `${result.baseBranch} (sub-task merged, no push to main)`
    : result.baseBranch;

  return `Task #${issueNumber} accepted.\nPR #${result.prNumber} merged → ${mergeTarget}\nIssue closed.`;
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

  const spinner = ora(`Merging PR for #${issueNumber}…`).start();
  try {
    const result = await acceptTask(config, issueNumber);
    spinner.stop();
    return `Task #${issueNumber} accepted.\nPR #${result.prNumber} merged → ${result.baseBranch}\nIssue closed.`;
  } catch (err) {
    spinner.stop();
    return `Error: ${(err as Error).message}`;
  }
}
export const terminal = true;
