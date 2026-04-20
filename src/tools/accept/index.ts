import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import ora from 'ora';
import type { TechunterConfig } from '../../types.js';
import {
  getAuthenticatedUser,
  listTasksForReview,
  acceptTask,
  getTask,
  mergeWorkerIntoBase,
  upsertRepoFile,
} from '../../lib/github.js';
import { isTaskBranch } from '../../lib/git.js';
import { getStatus } from '../../lib/display.js';
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

function ensureTaskIsInReview(issue: Awaited<ReturnType<typeof getTask>>): string | null {
  const status = getStatus(issue);
  if (status === 'in-review') return null;
  return `Task #${issue.number} is not in review. Current status: ${status}.`;
}

async function maybeMergeWorkerToBase(
  config: TechunterConfig,
  workerBranch: string,
  interactive: boolean,
): Promise<{ merged: boolean; targetBranch: string; warning?: string }> {
  const baseBranch = config.baseBranch ?? 'main';

  if (isTaskBranch(workerBranch) || workerBranch === baseBranch) {
    return { merged: false, targetBranch: workerBranch };
  }

  if (interactive) {
    let pushToBase: boolean;
    try {
      pushToBase = await select({
        message: `Push ${chalk.cyan(workerBranch)} -> ${chalk.cyan(baseBranch)}?`,
        choices: [
          { name: `Yes, push to ${baseBranch}`, value: true },
          { name: 'No, keep in worker branch', value: false },
        ],
      });
    } catch {
      pushToBase = false;
    }

    if (!pushToBase) {
      return { merged: false, targetBranch: workerBranch };
    }
  }

  try {
    await mergeWorkerIntoBase(config, workerBranch, baseBranch);
    return { merged: true, targetBranch: baseBranch };
  } catch (err) {
    return {
      merged: false,
      targetBranch: workerBranch,
      warning: `Could not merge ${workerBranch} into ${baseBranch}: ${(err as Error).message}`,
    };
  }
}

export async function run(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  let issueNumber = input['issue_number'] as number | undefined;

  if (!issueNumber) {
    const spinner = ora('Loading tasks for review...').start();
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
          name: `#${t.number}  @${t.assignee ?? '-'}  ${t.title}`,
          value: t.number,
        })),
      });
    } catch {
      return 'Cancelled.';
    }
  }

  const spinner2 = ora('Verifying permissions...').start();
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

  const reviewStatusError = ensureTaskIsInReview(issue);
  if (reviewStatusError) return reviewStatusError;

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

  const spinner = ora(`Merging PR for #${issueNumber}...`).start();
  let result: Awaited<ReturnType<typeof acceptTask>>;
  try {
    result = await acceptTask(config, issueNumber);
    spinner.succeed(`PR #${result.prNumber} merged -> ${chalk.cyan(result.baseBranch)}`);
  } catch (err) {
    spinner.fail('Failed');
    return `Error: ${(err as Error).message}`;
  }

  const baseMerge = await maybeMergeWorkerToBase(config, result.baseBranch, true);
  if (baseMerge.warning) {
    console.log(chalk.yellow(baseMerge.warning));
  } else if (baseMerge.merged) {
    console.log(chalk.green(`Merged ${result.baseBranch} -> ${baseMerge.targetBranch}`));
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
  } catch {
    // skip
  }

  if (updateWiki) {
    const wikiSpinner = ora('Regenerating TECHUNTER.md...').start();
    try {
      const content = await generateWiki(config);
      await upsertRepoFile(config, 'TECHUNTER.md', content, 'docs: update TECHUNTER.md project overview');
      wikiSpinner.succeed('TECHUNTER.md updated');
    } catch (err) {
      wikiSpinner.fail(`Wiki update failed: ${(err as Error).message}`);
    }
  }

  const summary = `Task #${issueNumber} accepted.\nPR #${result.prNumber} merged -> ${baseMerge.targetBranch}\nIssue closed.`;
  if (!baseMerge.warning) return summary;
  return `${summary}\nWarning: ${baseMerge.warning}`;
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

  const reviewStatusError = ensureTaskIsInReview(issue);
  if (reviewStatusError) return reviewStatusError;

  const spinner = ora(`Merging PR for #${issueNumber}...`).start();
  try {
    const result = await acceptTask(config, issueNumber);
    spinner.stop();

    const baseMerge = await maybeMergeWorkerToBase(config, result.baseBranch, false);
    const summary = `Task #${issueNumber} accepted.\nPR #${result.prNumber} merged -> ${baseMerge.targetBranch}\nIssue closed.`;
    if (!baseMerge.warning) return summary;
    return `${summary}\nWarning: ${baseMerge.warning}`;
  } catch (err) {
    spinner.stop();
    return `Error: ${(err as Error).message}`;
  }
}

export const terminal = true;
