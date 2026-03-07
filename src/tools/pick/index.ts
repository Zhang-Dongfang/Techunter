import chalk from 'chalk';
import ora from 'ora';
import { select } from '@inquirer/prompts';
import type { TechunterConfig } from '../../types.js';
import {
  listTasks,
  getTask,
  claimTask,
  listComments,
} from '../../lib/github.js';
import { createAndSwitchBranch, pushBranch, makeBranchName } from '../../lib/git.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { getStatus, colorStatus, printTaskDetail } from '../../lib/display.js';
import { launchClaudeCode } from '../../lib/launch.js';
import { run as runSubmit } from '../submit/index.js';
import { run as runClose } from '../close/index.js';

export const definition = {
  type: 'function',
  function: {
    name: 'pick',
    description:
      'Browse the task list and act on a specific task (claim, submit, close, or view). ' +
      'Equivalent to /pick. Use when the user wants to explore or take action on a task.',
    parameters: {
      type: 'object',
      properties: {
        issue_number: {
          type: 'number',
          description: 'Pre-select a specific issue to jump directly to it (optional).',
        },
      },
      required: [],
    },
  },
} as const;

export async function run(config: TechunterConfig, preselected?: number): Promise<string> {
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
        choices: tasks.map((t) => ({
          name: `#${String(t.number).padEnd(4)} ${colorStatus(getStatus(t))} ${t.title}`,
          value: t.number,
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
        const c = comments[0];
        const divider = chalk.dim('─'.repeat(70));
        console.log(
          chalk.red.bold('  Latest rejection feedback') +
          chalk.dim(` — @${c.author} · ${c.createdAt.slice(0, 10)}`)
        );
        console.log(divider);
        console.log(renderMarkdown(c.body));
        console.log(divider + '\n');
      }
    } catch {
      // silently skip
    }
  }

  const actions: { name: string; value: string }[] = [];
  if (status === 'available') actions.push({ name: 'Claim this task', value: 'claim' });
  if (status === 'claimed' || status === 'changes-needed') actions.push({ name: 'Submit this task', value: 'submit' });
  actions.push({ name: 'Close this task', value: 'close' });
  actions.push({ name: 'Nothing, just viewing', value: 'none' });

  let action: string;
  try {
    action = await select({ message: 'Action:', choices: actions });
  } catch {
    return 'Cancelled.';
  }

  if (action === 'none') return `Viewed task #${issue.number}.`;

  if (action === 'claim') {
    try {
      const { getAuthenticatedUser } = await import('../../lib/github.js');
      const me = await getAuthenticatedUser(config);
      let spinner = ora(`Claiming #${issue.number}…`).start();
      await claimTask(config, issue.number, me);
      spinner.stop();
      const branch = makeBranchName(issue.number, issue.title);
      spinner = ora(`Creating branch ${branch}…`).start();
      try { await createAndSwitchBranch(branch); spinner.stop(); }
      catch { spinner.warn(`Could not create branch ${branch}`); }
      spinner = ora('Pushing branch…').start();
      try { await pushBranch(branch); spinner.stop(); }
      catch { spinner.warn('Could not push branch'); }
      console.log(chalk.green(`\n  Claimed! Branch: ${branch}\n`));
      let openClaude: boolean;
      try {
        openClaude = await select({
          message: 'Open Claude Code for this task?',
          choices: [
            { name: 'Yes, start coding now', value: true },
            { name: 'No, return to tch', value: false },
          ],
        });
      } catch { openClaude = false; }
      if (openClaude) await launchClaudeCode(issue, branch);
      return `Task #${issue.number} claimed. Branch: ${branch}`;
    } catch (err) {
      return `Error claiming task: ${(err as Error).message}`;
    }
  }

  if (action === 'submit') return runSubmit(config);
  if (action === 'close') return runClose(config, { issue_number: issue.number });

  return 'Cancelled.';
}

export const execute = (input: Record<string, unknown>, config: TechunterConfig) =>
  run(config, input['issue_number'] as number | undefined);
