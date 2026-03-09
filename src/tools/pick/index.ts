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
import { makeBranchName, makeWorkerBranchName, switchToBranchOrCreate, pushBranch, getCurrentCommit } from '../../lib/git.js';
import { setConfig } from '../../lib/config.js';
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
        issue_number: { type: 'number', description: 'Issue number to act on.' },
        action: {
          type: 'string',
          enum: ['claim', 'view'],
          description: '"claim" to assign yourself and create a branch; "view" to return task details.',
        },
      },
      required: ['issue_number', 'action'],
    },
  },
} as const;

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
      const { getAuthenticatedUser, listMyTasks } = await import('../../lib/github.js');
      const me = await getAuthenticatedUser(config);

      // WIP limit: block if user already has an active task
      const myTasks = await listMyTasks(config, me);
      const activeTask = myTasks.find((t) => {
        const labels = t.labels;
        return labels.includes('techunter:claimed') || labels.includes('techunter:changes-needed');
      });
      if (activeTask) {
        return (
          `You already have an active task: #${activeTask.number} "${activeTask.title}"\n` +
          `Finish or submit it before claiming a new one.`
        );
      }

      let spinner = ora(`Claiming #${issue.number}…`).start();
      await claimTask(config, issue.number, me);
      spinner.stop();

      // Ensure personal worker branch exists
      const workerBranch = makeWorkerBranchName(me);
      spinner = ora(`Switching to ${workerBranch}…`).start();
      try {
        const isNewWorker = await switchToBranchOrCreate(workerBranch);
        spinner.stop();
        if (isNewWorker) {
          spinner = ora('Pushing worker branch…').start();
          try { await pushBranch(workerBranch); spinner.stop(); }
          catch { spinner.warn('Could not push worker branch'); }
        }
      } catch { spinner.warn(`Could not switch to ${workerBranch}`); }

      // Create task-specific branch from worker branch
      const branch = makeBranchName(issue.number, me);
      spinner = ora(`Creating task branch ${branch}…`).start();
      try {
        await switchToBranchOrCreate(branch);
        spinner.stop();
        spinner = ora('Pushing task branch…').start();
        try { await pushBranch(branch); spinner.stop(); }
        catch { spinner.warn('Could not push task branch'); }
      } catch { spinner.warn(`Could not create branch ${branch}`); }

      const baseCommit = await getCurrentCommit();
      setConfig({ taskState: { activeIssueNumber: issue.number, baseCommit } });
      console.log(chalk.green(`\n  Claimed! Branch: ${branch}  (base: ${baseCommit.slice(0, 7)})\n`));
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

  if (action === 'submit') return runSubmit({}, config);
  if (action === 'close') return runClose({ issue_number: issue.number }, config);

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
    const assignee = issue.assignee ? `@${issue.assignee}` : '—';
    return [`#${issue.number}  [${status}]  ${assignee}  ${issue.title}`, issue.body ?? ''].join('\n\n');
  }

  if (action === 'claim') {
    const { getAuthenticatedUser, listMyTasks } = await import('../../lib/github.js');
    const me = await getAuthenticatedUser(config);

    const myTasks = await listMyTasks(config, me);
    const activeTask = myTasks.find((t) => {
      return t.labels.includes('techunter:claimed') || t.labels.includes('techunter:changes-needed');
    });
    if (activeTask) {
      return `You already have an active task: #${activeTask.number} "${activeTask.title}". Finish it before claiming a new one.`;
    }

    try {
      await claimTask(config, issueNumber, me);
    } catch (err) {
      return `Error claiming task: ${(err as Error).message}`;
    }

    // Ensure personal worker branch exists
    const workerBranch = makeWorkerBranchName(me);
    try {
      const isNewWorker = await switchToBranchOrCreate(workerBranch);
      if (isNewWorker) { try { await pushBranch(workerBranch); } catch { /* ignore */ } }
    } catch { /* ignore */ }

    // Create task-specific branch from worker branch
    const branch = makeBranchName(issueNumber, me);
    try { await switchToBranchOrCreate(branch); } catch { /* ignore */ }
    try { await pushBranch(branch); } catch { /* ignore */ }
    const baseCommit = await getCurrentCommit();
    setConfig({ taskState: { activeIssueNumber: issueNumber, baseCommit } });

    return `Task #${issueNumber} claimed. Branch: ${branch} (base commit: ${baseCommit.slice(0, 7)})`;
  }

  return `Unknown action: ${action}`;
}
export const terminal = true;
