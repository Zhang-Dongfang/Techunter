import { select, input as promptInput } from '@inquirer/prompts';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ora from 'ora';
import chalk from 'chalk';
import open from 'open';
import type { TechunterConfig } from '../../types.js';
import { createTask, getAuthenticatedUser, isCollaborator } from '../../lib/github.js';
import { syncWithBase, getCurrentCommit, getRemoteHeadSha, getCurrentBranch, isTaskBranch, makeWorkerBranchName, hasUncommittedChanges, stash } from '../../lib/git.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { generateGuide } from './guide-generator.js';

async function openInEditor(content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tch-guide-'));
  const file = path.join(dir, 'guide.md');
  try {
    await writeFile(file, content, 'utf-8');
    const editor =
      process.env['EDITOR'] ??
      process.env['VISUAL'] ??
      (process.platform === 'win32' ? 'notepad' : 'vi');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(editor, [file], { stdio: 'inherit', shell: true });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Editor exited with code ${code}`))));
      child.on('error', reject);
    });
    return await readFile(file, 'utf-8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function resolveBaseAndTarget(
  config: TechunterConfig,
  me: string,
  interactive: boolean
): Promise<{ baseCommit: string | undefined; targetBranch: string; isSubtask: boolean }> {
  const currentBranch = await getCurrentBranch();

  if (isTaskBranch(currentBranch)) {
    // Sub-task: base from current task branch HEAD, target = current task branch.
    // Uncommitted changes won't be included in baseCommit — executor starts without them.
    if (await hasUncommittedChanges()) {
      if (!interactive) {
        throw new Error('Cannot create sub-task: you have uncommitted changes. Commit them first so the executor starts from the correct base.');
      }
      const { select: inquirerSelect } = await import('@inquirer/prompts');
      let choice: string;
      try {
        choice = await inquirerSelect({
          message: 'You have uncommitted changes. The sub-task executor will start from the last commit — they won\'t see your current unsaved work.',
          choices: [
            { name: 'Commit first (cancel and commit manually)', value: 'cancel' },
            { name: 'Continue anyway (executor starts without my unsaved changes)', value: 'continue' },
          ],
        });
      } catch { choice = 'cancel'; }
      if (choice === 'cancel') throw new Error('Cancelled. Commit your changes first, then create the sub-task.');
    }
    const baseCommit = await getCurrentCommit();
    return { baseCommit, targetBranch: currentBranch, isSubtask: true };
  }

  // Root task: check staging area before syncing with main
  if (await hasUncommittedChanges()) {
    if (!interactive) {
      throw new Error('Cannot create task: you have uncommitted changes. Commit or stash them first (git stash).');
    }
    const { select: inquirerSelect } = await import('@inquirer/prompts');
    let choice: string;
    try {
      choice = await inquirerSelect({
        message: 'You have uncommitted changes. Syncing with main requires a clean working tree.',
        choices: [
          { name: 'Stash changes and continue (restore with: git stash pop)', value: 'stash' },
          { name: 'Cancel', value: 'cancel' },
        ],
      });
    } catch { choice = 'cancel'; }
    if (choice === 'cancel') throw new Error('Cancelled.');
    await stash('tch: before creating new task');
    console.log(chalk.dim('  Changes stashed. Run `git stash pop` after creating the task.'));
  }

  // Root task: sync with main, target = worker branch
  const baseBranch = config.baseBranch ?? 'main';
  let baseCommit: string | undefined;
  const syncSpinner = ora(`Syncing with ${baseBranch}…`).start();
  try {
    await syncWithBase(baseBranch);
    baseCommit = await getCurrentCommit();
    syncSpinner.succeed(`Synced with ${baseBranch} (base: ${baseCommit.slice(0, 7)})`);
  } catch {
    syncSpinner.warn(`Could not sync with ${baseBranch} — recording remote HEAD as base`);
    try { baseCommit = await getRemoteHeadSha(baseBranch); } catch { /* ignore */ }
  }
  return { baseCommit, targetBranch: makeWorkerBranchName(me), isSubtask: false };
}

export const definition = {
  type: 'function',
  function: {
    name: 'new_task',
    description:
      'Create a new task (GitHub Issue): scans the project, generates a full implementation guide, ' +
      'then creates the issue. Equivalent to /new.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title.' },
        feedback: { type: 'string', description: 'Optional feedback to revise the generated guide before creating the issue.' },
      },
      required: ['title'],
    },
  },
} as const;

export async function run(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const authSpinner = ora('Checking permissions…').start();
  let me: string;
  let allowed: boolean;
  try {
    me = await getAuthenticatedUser(config);
    allowed = await isCollaborator(config, me);
    authSpinner.stop();
  } catch (err) {
    authSpinner.stop();
    return `Error checking permissions: ${(err as Error).message}`;
  }
  if (!allowed) {
    return `Permission denied: only repository collaborators can create tasks.`;
  }

  let title = (input['title'] as string | undefined)?.trim();
  if (!title) {
    try {
      title = (await promptInput({ message: 'Task title:' })).trim();
    } catch {
      return 'Cancelled.';
    }
    if (!title) return 'Cancelled.';
  }

  const spinner = ora('Scanning project and generating guide…').start();
  let guide: string;
  try {
    guide = await generateGuide(config, title);
    spinner.stop();
  } catch (err) {
    spinner.stop();
    return `Error generating guide: ${(err as Error).message}`;
  }

  const divider = chalk.dim('─'.repeat(70));

  for (;;) {
    console.log('\n' + divider);
    console.log(chalk.bold('  Generated guide preview'));
    console.log(divider);
    console.log(renderMarkdown(guide));
    console.log(divider + '\n');

    let action: string;
    try {
      action = await select({
        message: 'Create this task?',
        choices: [
          { name: 'Yes, create task', value: 'create' },
          { name: 'Edit in editor', value: 'edit' },
          { name: 'Let AI revise', value: 'ai' },
          { name: 'Cancel', value: 'cancel' },
        ],
      });
    } catch {
      return 'Cancelled.';
    }

    if (action === 'cancel') return 'Cancelled.';
    if (action === 'create') break;

    if (action === 'edit') {
      try {
        guide = await openInEditor(guide);
      } catch (err) {
        console.log(chalk.yellow(`  Editor error: ${(err as Error).message}`));
      }
      continue;
    }

    // ai revise
    let feedback: string;
    try {
      feedback = (await promptInput({ message: 'What should be changed?' })).trim();
    } catch {
      return 'Cancelled.';
    }
    if (!feedback) continue;

    const reviseSpinner = ora('Revising guide…').start();
    try {
      guide = await generateGuide(config, title, { feedback, previousGuide: guide });
      reviseSpinner.stop();
    } catch (err) {
      reviseSpinner.stop();
      console.log(chalk.yellow(`  Revision error: ${(err as Error).message}`));
    }
  }

  let baseCommit: string | undefined;
  let targetBranch: string;
  let isSubtask: boolean;
  try {
    ({ baseCommit, targetBranch, isSubtask } = await resolveBaseAndTarget(config, me, true));
  } catch (err) {
    return (err as Error).message;
  }

  if (isSubtask) {
    console.log(chalk.dim(`  Sub-task: will target branch ${chalk.cyan(targetBranch)} (base: ${baseCommit?.slice(0, 7) ?? 'HEAD'})`));
  }

  const createSpinner = ora(`Creating "${title}"…`).start();
  let htmlUrl: string;
  let issueNumber: number;
  let issueTitle: string;
  try {
    const issue = await createTask(config, title, guide, baseCommit, targetBranch);
    createSpinner.stop();
    htmlUrl = issue.htmlUrl;
    issueNumber = issue.number;
    issueTitle = issue.title;
  } catch (err) {
    createSpinner.stop();
    return `Error: ${(err as Error).message}`;
  }

  console.log(chalk.green(`\n  Created #${issueNumber} "${issueTitle}"\n  ${chalk.dim(htmlUrl)}\n`));

  try {
    const openBrowser = await select({
      message: 'Open issue in browser?',
      choices: [
        { name: 'Yes', value: true },
        { name: 'No', value: false },
      ],
    });
    if (openBrowser) await open(htmlUrl);
  } catch { /* skip */ }

  return `Created #${issueNumber} "${issueTitle}" — ${htmlUrl}`;
}

export async function execute(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const me = await getAuthenticatedUser(config);
  if (!await isCollaborator(config, me)) {
    return `Permission denied: only repository collaborators can create tasks.`;
  }

  const title = (input['title'] as string).trim();
  const feedback = input['feedback'] as string | undefined;

  let guide = await generateGuide(config, title);

  if (feedback) {
    guide = await generateGuide(config, title, { feedback, previousGuide: guide });
  }

  const { baseCommit, targetBranch } = await resolveBaseAndTarget(config, me, false);

  try {
    const issue = await createTask(config, title, guide, baseCommit, targetBranch);
    return `Created #${issue.number} "${issue.title}" — ${issue.htmlUrl}\n\nGuide:\n${guide}`;
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}
export const terminal = true;
