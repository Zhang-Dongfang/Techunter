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
import {
  makeTaskBranchName,
  checkoutFromCommit,
  switchToBranchOrCreate,
  pushBranch,
  getCurrentCommit,
  getCurrentBranch,
  hasUncommittedChanges,
  stash,
  stashPop,
} from '../../lib/git.js';
import { extractBaseCommit } from '../../lib/github.js';
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
  if (status === 'available') {
    actions.push({ name: 'Claim this task', value: 'claim' });
  }
  if (status === 'claimed') {
    actions.push({ name: 'Submit this task', value: 'submit' });
  }
  if (status === 'changes-needed') {
    const { getAuthenticatedUser } = await import('../../lib/github.js');
    const me = await getAuthenticatedUser(config);
    const taskBranch = issue.assignee
      ? makeTaskBranchName(issue.number, issue.assignee)
      : makeTaskBranchName(issue.number, me);
    const currentBranch = await getCurrentBranch();
    if (currentBranch === taskBranch) {
      actions.push({ name: 'Submit this task (fixes done)', value: 'submit' });
    } else {
      actions.push({ name: `Switch to ${taskBranch} to fix`, value: 'switch-fix' });
    }
  }
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

      // WIP limit: block if user already has an active claimed/changes-needed task
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

      // Check for uncommitted changes before switching branches
      let stashed = false;
      if (await hasUncommittedChanges()) {
        let choice: string;
        try {
          choice = await select({
            message: 'You have uncommitted changes. What would you like to do?',
            choices: [
              { name: 'Stash changes and switch branch (restore with: git stash pop)', value: 'stash' },
              { name: 'Cancel', value: 'cancel' },
            ],
          });
        } catch { choice = 'cancel'; }
        if (choice === 'cancel') return 'Cancelled.';
        await stash(`tch: before claiming #${issue.number}`);
        stashed = true;
        console.log(chalk.dim('  Changes stashed. Run `git stash pop` after you finish this task to restore them.'));
      }

      let spinner = ora(`Claiming #${issue.number}…`).start();
      await claimTask(config, issue.number, me);
      spinner.stop();

      const taskBranch = makeTaskBranchName(issue.number, me);
      const taskBase = extractBaseCommit(issue.body);
      spinner = ora(`Creating branch ${taskBranch}${taskBase ? ` from ${taskBase.slice(0, 7)}` : ''}…`).start();
      try {
        if (taskBase) {
          await checkoutFromCommit(taskBranch, taskBase);
        } else {
          await switchToBranchOrCreate(taskBranch);
        }
        spinner.stop();
        spinner = ora('Pushing task branch…').start();
        try {
          await pushBranch(taskBranch);
          spinner.stop();
        } catch {
          spinner.warn('Could not push task branch — will push on submit');
        }
      } catch (err) {
        spinner.warn(`Could not switch to ${taskBranch}`);
        if (stashed) {
          try {
            await stashPop();
            console.log(chalk.dim('  Restored stashed changes.'));
          } catch {
            console.log(chalk.yellow('  Warning: could not restore stash automatically. Run `git stash pop` manually.'));
          }
        }
        throw err;
      }

      const baseCommit = await getCurrentCommit();
      setConfig({ taskState: { activeIssueNumber: issue.number, baseCommit, activeBranch: taskBranch } });
      console.log(chalk.green(`\n  Claimed! Branch: ${taskBranch}  (base: ${baseCommit.slice(0, 7)})\n`));
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
      if (openClaude) await launchClaudeCode(issue, taskBranch);
      return `Task #${issue.number} claimed. Branch: ${taskBranch}`;
    } catch (err) {
      return `Error claiming task: ${(err as Error).message}`;
    }
  }

  if (action === 'switch-fix') {
    const { getAuthenticatedUser } = await import('../../lib/github.js');
    const me = await getAuthenticatedUser(config);
    const taskBranch = issue.assignee
      ? makeTaskBranchName(issue.number, issue.assignee)
      : makeTaskBranchName(issue.number, me);

    let stashed = false;
    if (await hasUncommittedChanges()) {
      let choice: string;
      try {
        choice = await select({
          message: 'You have uncommitted changes. What would you like to do?',
          choices: [
            { name: 'Stash changes and switch branch (restore with: git stash pop)', value: 'stash' },
            { name: 'Cancel', value: 'cancel' },
          ],
        });
      } catch { choice = 'cancel'; }
      if (choice === 'cancel') return 'Cancelled.';
      await stash(`tch: before switching to ${taskBranch}`);
      stashed = true;
      console.log(chalk.dim('  Changes stashed. Run `git stash pop` to restore them later.'));
    }

    const spinner = ora(`Switching to ${taskBranch}…`).start();
    try {
      await switchToBranchOrCreate(taskBranch);
      spinner.stop();
    } catch (err) {
      spinner.warn(`Could not switch to ${taskBranch}: ${(err as Error).message}`);
      if (stashed) {
        try { await stashPop(); console.log(chalk.dim('  Restored stashed changes.')); }
        catch { console.log(chalk.yellow('  Run `git stash pop` manually to restore your changes.')); }
      }
      return `Error: ${(err as Error).message}`;
    }

    const baseCommit = await getCurrentCommit();
    setConfig({ taskState: { activeIssueNumber: issue.number, baseCommit, activeBranch: taskBranch } });
    console.log(chalk.green(`\n  Switched to ${taskBranch}. Fix the issues then run /submit.\n`));
    return `Switched to ${taskBranch} for task #${issue.number}.`;
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

    if (await hasUncommittedChanges()) {
      return 'Cannot claim: you have uncommitted changes. Commit or stash them first (git stash).';
    }

    try {
      await claimTask(config, issueNumber, me);
    } catch (err) {
      return `Error claiming task: ${(err as Error).message}`;
    }

    const taskBranch = makeTaskBranchName(issue.number, me);
    const taskBase = extractBaseCommit(issue.body);
    try {
      if (taskBase) {
        await checkoutFromCommit(taskBranch, taskBase);
      } else {
        await switchToBranchOrCreate(taskBranch);
      }
    } catch { /* ignore */ }
    try { await pushBranch(taskBranch); } catch { /* push on submit */ }
    const baseCommit = await getCurrentCommit();
    setConfig({ taskState: { activeIssueNumber: issueNumber, baseCommit, activeBranch: taskBranch } });

    return `Task #${issueNumber} claimed. Branch: ${taskBranch} (base commit: ${baseCommit.slice(0, 7)})`;
  }

  return `Unknown action: ${action}`;
}
export const terminal = true;
