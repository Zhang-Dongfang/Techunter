import chalk from 'chalk';
import ora from 'ora';
import { select } from '@inquirer/prompts';
import type { TechunterConfig } from '../../types.js';
import { getAuthenticatedUser, listTasksForReview, getTaskPR, getTaskPRDiff } from '../../lib/github.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { run as runAccept } from '../accept/index.js';
import { run as runReject } from '../reject/index.js';

export const definition = {
  type: 'function',
  function: {
    name: 'review',
    description: 'List tasks waiting for your review (submitted by others, created by you), then let you accept or reject one. Equivalent to /review.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
} as const;

export async function run(_input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const spinner = ora('Loading tasks for review…').start();
  let me: string;
  let tasks: Awaited<ReturnType<typeof listTasksForReview>>;
  try {
    me = await getAuthenticatedUser(config);
    tasks = await listTasksForReview(config, me);
    spinner.stop();
  } catch (err) {
    spinner.stop();
    return `Error: ${(err as Error).message}`;
  }

  if (tasks.length === 0) return `No tasks pending review for @${me}.`;

  let issueNumber: number;
  try {
    issueNumber = await select({
      message: 'Select a task to review:',
      choices: tasks.map((t) => ({
        name: `#${String(t.number).padEnd(4)} @${t.assignee ?? '—'}  ${t.title}`,
        value: t.number,
      })),
    });
  } catch {
    return 'Cancelled.';
  }

  const spinner2 = ora(`Loading #${issueNumber}…`).start();
  let pr: Awaited<ReturnType<typeof getTaskPR>>;
  try {
    pr = await getTaskPR(config, issueNumber);
    spinner2.stop();
  } catch (err) {
    spinner2.stop();
    return `Error loading PR: ${(err as Error).message}`;
  }

  const divider = chalk.dim('─'.repeat(70));
  console.log('\n' + divider);
  if (pr) {
    console.log(chalk.bold(`  PR #${pr.number}`) + '  ' + chalk.dim(pr.url));
    console.log(divider);
    console.log(renderMarkdown(pr.body));
  } else {
    console.log(chalk.yellow(`  No open PR found for task #${issueNumber}`));
  }
  console.log(divider + '\n');

  for (;;) {
    let action: string;
    try {
      action = await select({
        message: 'Review action:',
        choices: [
          ...(pr ? [{ name: 'View diff', value: 'diff' }] : []),
          { name: chalk.green('Accept') + ' — merge PR and close issue', value: 'accept' },
          { name: chalk.red('Reject') + ' — request changes', value: 'reject' },
          { name: 'Nothing, just viewing', value: 'none' },
        ],
      });
    } catch {
      return 'Cancelled.';
    }

    if (action === 'none') return `Viewed task #${issueNumber}.`;
    if (action === 'accept') return runAccept({ issue_number: issueNumber }, config);
    if (action === 'reject') return runReject({ issue_number: issueNumber }, config);

    if (action === 'diff') {
      const diffSpinner = ora('Fetching diff…').start();
      let diff: string;
      try {
        diff = await getTaskPRDiff(config, pr!.number);
        diffSpinner.stop();
      } catch (err) {
        diffSpinner.stop();
        console.log(chalk.red(`Error fetching diff: ${(err as Error).message}`));
        continue;
      }
      console.log('\n' + divider);
      // Colorize diff lines
      for (const line of diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          process.stdout.write(chalk.green(line) + '\n');
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          process.stdout.write(chalk.red(line) + '\n');
        } else if (line.startsWith('@@')) {
          process.stdout.write(chalk.cyan(line) + '\n');
        } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) {
          process.stdout.write(chalk.bold(line) + '\n');
        } else {
          process.stdout.write(line + '\n');
        }
      }
      console.log(divider + '\n');
    }
  }
}

export const execute = run;
export const terminal = true;
