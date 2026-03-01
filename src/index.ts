#!/usr/bin/env node
import chalk from 'chalk';
import { select, input } from '@inquirer/prompts';
import type OpenAI from 'openai';
import { initCommand } from './commands/init.js';
import { getConfig } from './lib/config.js';
import {
  listTasks,
  getTask,
  createTask,
  closeTask,
  claimTask,
  createPR,
  markInReview,
  getDefaultBranch,
  getAuthenticatedUser,
  listMyTasks,
} from './lib/github.js';
import { getCurrentBranch, pushBranch, makeBranchName, createAndSwitchBranch, stageAllAndCommit, hasUncommittedChanges } from './lib/git.js';
import { runAgentLoop } from './lib/agent.js';
import type { TechunterConfig, GitHubIssue } from './types.js';

const LABEL_AVAILABLE = 'techunter:available';
const LABEL_CLAIMED = 'techunter:claimed';
const LABEL_IN_REVIEW = 'techunter:in-review';

function getStatus(issue: GitHubIssue): string {
  if (issue.labels.includes(LABEL_IN_REVIEW)) return 'in-review';
  if (issue.labels.includes(LABEL_CLAIMED)) return 'claimed';
  if (issue.labels.includes(LABEL_AVAILABLE)) return 'available';
  return 'unknown';
}

function colorStatus(status: string): string {
  const padded = status.padEnd(12);
  switch (status) {
    case 'available': return chalk.green(padded);
    case 'claimed':   return chalk.yellow(padded);
    case 'in-review': return chalk.blue(padded);
    default:          return padded;
  }
}

function printTaskDetail(issue: GitHubIssue): void {
  const divider = chalk.dim('─'.repeat(70));
  console.log('\n' + divider);
  console.log(
    chalk.bold(` #${issue.number}`) +
    '  ' + colorStatus(getStatus(issue)) +
    '  ' + chalk.dim(issue.assignee ? `@${issue.assignee}` : '—')
  );
  console.log(chalk.bold('\n ' + issue.title));
  if (issue.body) {
    console.log('');
    for (const line of issue.body.split('\n')) {
      console.log(' ' + chalk.dim(line));
    }
  }
  console.log('\n ' + chalk.dim(issue.htmlUrl));
  console.log(divider + '\n');
}

async function printTaskList(config: TechunterConfig): Promise<void> {
  try {
    const tasks = await listTasks(config);
    const divider = chalk.dim('─'.repeat(70));

    console.log('');
    console.log(
      chalk.dim(' ' + '#'.padEnd(5) + 'Status'.padEnd(14) + 'Assignee'.padEnd(16) + 'Title')
    );
    console.log(divider);

    if (tasks.length === 0) {
      console.log(chalk.dim('  (no tasks)'));
    } else {
      for (const t of tasks) {
        const num = `#${t.number}`.padEnd(5);
        const status = colorStatus(getStatus(t));
        const assignee = (t.assignee ? `@${t.assignee}` : '—').padEnd(16);
        const title = t.title.length > 36 ? t.title.slice(0, 33) + '...' : t.title;
        console.log(` ${num}${status}${assignee}${title}`);
      }
    }

    console.log(divider);
  } catch (err) {
    console.log(chalk.yellow(`(Could not load tasks: ${(err as Error).message})`));
  }
}

// ─── Slash commands ───────────────────────────────────────────────────────────

const COMMANDS: { cmd: string; alias?: string; desc: string }[] = [
  { cmd: '/help',    alias: '/h',  desc: 'Show available commands' },
  { cmd: '/refresh', alias: '/r',  desc: 'Reload the task list' },
  { cmd: '/pick',    alias: '/p',  desc: 'Browse tasks and view details' },
  { cmd: '/new',     alias: '/n',  desc: 'Create a new task interactively' },
  { cmd: '/close',   alias: '/d',  desc: 'Close (delete) a task' },
  { cmd: '/submit',  alias: '/s',  desc: 'Review changes and sync to remote' },
  { cmd: '/status',  alias: '/me', desc: 'Show tasks assigned to you' },
];

function cmdHelp(): void {
  console.log('');
  console.log(chalk.bold('  Commands'));
  console.log(chalk.dim('  ─'.repeat(35)));
  for (const { cmd, alias, desc } of COMMANDS) {
    const left = (cmd + (alias ? `  ${chalk.dim(alias)}` : '')).padEnd(22);
    console.log(`  ${chalk.cyan(cmd)}${alias ? '  ' + chalk.dim(alias) : ''}`.padEnd(30) + chalk.dim(desc));
  }
  console.log(chalk.dim('\n  Anything else is sent to the AI agent.\n'));
}

// Returns an agent request string if the user chose an action, otherwise null
async function cmdPick(config: TechunterConfig): Promise<string | null> {
  let tasks: GitHubIssue[];
  try {
    tasks = await listTasks(config);
  } catch (err) {
    console.log(chalk.red(`  Could not load tasks: ${(err as Error).message}`));
    return null;
  }

  if (tasks.length === 0) {
    console.log(chalk.dim('\n  (no tasks)\n'));
    return null;
  }

  let chosen: number;
  try {
    chosen = await select({
      message: 'Select a task:',
      choices: tasks.map((t) => ({
        name: `#${String(t.number).padEnd(4)} ${colorStatus(getStatus(t))} ${t.title}`,
        value: t.number,
      })),
    });
  } catch {
    return null;
  }

  let issue: GitHubIssue;
  try {
    issue = await getTask(config, chosen);
  } catch (err) {
    console.log(chalk.red(`  Could not load task: ${(err as Error).message}`));
    return null;
  }

  printTaskDetail(issue);

  const status = getStatus(issue);
  const actions: { name: string; value: string | null }[] = [];

  if (status === 'available') {
    actions.push({ name: 'Claim this task', value: `__claim__${chosen}` });
  }
  if (status === 'claimed') {
    actions.push({ name: 'Submit changes (/submit)', value: '__submit__' });
    actions.push({ name: 'Create PR (deliver)', value: `__deliver__${chosen}` });
  }
  actions.push({ name: 'Close this task', value: `__close__${chosen}` });
  actions.push({ name: 'Nothing, just viewing', value: null });

  let action: string | null;
  try {
    action = await select({ message: 'Action:', choices: actions });
  } catch {
    return null;
  }

  return action;
}

async function cmdNew(config: TechunterConfig): Promise<void> {
  let title: string;
  let body: string;

  try {
    title = await input({ message: 'Task title:', required: true });
    body  = await input({ message: 'Description (optional, Enter to skip):' });
  } catch {
    return;
  }

  try {
    const issue = await createTask(config, title, body || undefined);
    console.log(chalk.green(`\n  Task created: #${issue.number} "${issue.title}"`));
    console.log(chalk.dim('  ' + issue.htmlUrl + '\n'));
  } catch (err) {
    console.log(chalk.red(`  Failed: ${(err as Error).message}`));
  }
}

async function cmdStatus(config: TechunterConfig): Promise<void> {
  try {
    const me = await getAuthenticatedUser(config);
    const tasks = await listMyTasks(config, me);

    const divider = chalk.dim('─'.repeat(70));
    console.log('\n' + divider);
    console.log(chalk.dim(` Tasks assigned to @${me}`));
    console.log(divider);

    if (tasks.length === 0) {
      console.log(chalk.dim('  (none)'));
    } else {
      for (const t of tasks) {
        const num = `#${t.number}`.padEnd(5);
        const status = colorStatus(getStatus(t));
        const title = t.title.length > 46 ? t.title.slice(0, 43) + '...' : t.title;
        console.log(` ${num}${status}${title}`);
      }
    }
    console.log(divider + '\n');
  } catch (err) {
    console.log(chalk.red(`  Could not fetch status: ${(err as Error).message}`));
  }
}

async function cmdClose(config: TechunterConfig): Promise<void> {
  let tasks: GitHubIssue[];
  try {
    tasks = await listTasks(config);
  } catch (err) {
    console.log(chalk.red(`  Could not load tasks: ${(err as Error).message}`));
    return;
  }

  if (tasks.length === 0) {
    console.log(chalk.dim('\n  (no tasks)\n'));
    return;
  }

  let chosen: number;
  try {
    chosen = await select({
      message: 'Select a task to close:',
      choices: tasks.map((t) => ({
        name: `#${String(t.number).padEnd(4)} ${colorStatus(getStatus(t))} ${t.title}`,
        value: t.number,
      })),
    });
  } catch {
    return;
  }

  let confirmed: boolean;
  try {
    confirmed = await select({
      message: `Close task #${chosen}? This cannot be undone.`,
      choices: [
        { name: 'Yes, close it', value: true },
        { name: 'Cancel',        value: false },
      ],
    });
  } catch {
    return;
  }

  if (!confirmed) return;

  try {
    await closeTask(config, chosen);
    console.log(chalk.green(`\n  Task #${chosen} closed.\n`));
  } catch (err) {
    console.log(chalk.red(`  Failed: ${(err as Error).message}`));
  }
}

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner(config: TechunterConfig): void {
  const { owner, repo } = config.github;
  const s = chalk.bold.white;

  // Horizontal sword: ◆ pommel · grip · crossguard · blade · tip ▶
  const sword = [
    s('   ▗▄▄▄▄▖   '),
    s('◆──▐████▌══▶'),
    s('   ▝▀▀▀▀▘   '),
  ];

  const info = [
    chalk.bold('Techunter') + chalk.dim(' v0.1.0'),
    chalk.cyan('GLM-5') + chalk.dim(' · zai-org'),
    chalk.dim(`${owner}/${repo}`),
  ];

  console.log('');
  for (let i = 0; i < 3; i++) {
    console.log(sword[i] + '  ' + info[i]);
  }
  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === 'init') {
    try {
      await initCommand();
    } catch (err) {
      console.error(chalk.red(`\nError: ${(err as Error).message}`));
      process.exit(1);
    }
    return;
  }

  let config: TechunterConfig;
  try {
    config = getConfig();
  } catch (err) {
    console.error(chalk.red(`\n${(err as Error).message}`));
    process.exit(1);
    return;
  }

  printBanner(config);
  console.log(chalk.dim('  Type /help for commands, or describe what you want.\n'));

  await printTaskList(config);

  process.on('SIGINT', () => {
    console.log(chalk.gray('\nGoodbye!'));
    process.exit(0);
  });

  const messages: OpenAI.ChatCompletionMessageParam[] = [];

  for (;;) {
    let userInput: string;
    try {
      userInput = await input({ message: chalk.cyan('You') });
    } catch {
      // Ctrl+C / Ctrl+D inside the prompt
      console.log(chalk.gray('\nGoodbye!'));
      process.exit(0);
    }

    userInput = userInput.trim();
    if (!userInput) continue;

    // Slash commands — handled locally, no AI call
    const cmd = userInput.split(/\s+/)[0].toLowerCase();
    if (cmd.startsWith('/')) {
      switch (cmd) {
        case '/help': case '/h':
          cmdHelp();
          break;
        case '/refresh': case '/r':
          await printTaskList(config);
          break;
        case '/pick': case '/p': {
          const action = await cmdPick(config);
          if (!action) break;

          if (action.startsWith('__claim__')) {
            // Direct claim: no LLM needed
            const num = parseInt(action.replace('__claim__', ''), 10);
            try {
              const me = await getAuthenticatedUser(config);
              const issue = await getTask(config, num);
              console.log(chalk.dim(`  Claiming #${num}…`));
              await claimTask(config, num, me);
              const branch = makeBranchName(num, issue.title);
              console.log(chalk.dim(`  Creating branch ${branch}…`));
              await createAndSwitchBranch(branch);
              await pushBranch(branch);
              console.log(chalk.green(`\n  Claimed! Branch: ${branch}\n`));
            } catch (err) {
              console.log(chalk.red(`  Failed: ${(err as Error).message}`));
            }
          } else if (action === '__submit__') {
            // reuse submit flow
            const submitMsg = `Please review the current git changes against the acceptance criteria for task #${chosen}. If all criteria are met, commit and push. If not, clearly list what is missing.`;
            const prevLen = messages.length;
            messages.push({ role: 'user', content: submitMsg });
            try {
              const r = await runAgentLoop(config, messages);
              console.log('\n' + chalk.green('Techunter:') + ' ' + r + '\n');
            } catch (err) {
              messages.splice(prevLen);
              console.error(chalk.red(`\nError: ${(err as Error).message}\n`));
            }
          } else if (action.startsWith('__deliver__')) {
            // Direct deliver: no LLM needed
            const num = parseInt(action.replace('__deliver__', ''), 10);
            try {
              const branch = await getCurrentBranch();
              const [issue, defaultBranch] = await Promise.all([
                getTask(config, num),
                getDefaultBranch(config),
              ]);
              console.log(chalk.dim(`  Pushing ${branch}…`));
              await pushBranch(branch);
              console.log(chalk.dim('  Creating pull request…'));
              const prUrl = await createPR(
                config,
                issue.title,
                `Closes #${num}\n\n${issue.body ?? ''}`.trim(),
                branch,
                defaultBranch,
              );
              await markInReview(config, num);
              console.log(chalk.green(`\n  PR created: ${prUrl}\n`));
            } catch (err) {
              console.log(chalk.red(`  Failed: ${(err as Error).message}`));
            }
          } else if (action.startsWith('__close__')) {
            const num = parseInt(action.replace('__close__', ''), 10);
            try {
              await closeTask(config, num);
              console.log(chalk.green(`\n  Task #${num} closed.\n`));
            } catch (err) {
              console.log(chalk.red(`  Failed: ${(err as Error).message}`));
            }
          } else {
            // Natural language action → agent
            const prevLen = messages.length;
            messages.push({ role: 'user', content: action });
            try {
              const r = await runAgentLoop(config, messages);
              console.log('\n' + chalk.green('Techunter:') + ' ' + r + '\n');
            } catch (err) {
              messages.splice(prevLen);
              console.error(chalk.red(`\nError: ${(err as Error).message}\n`));
            }
          }
          await printTaskList(config);
          break;
        }
        case '/new': case '/n':
          await cmdNew(config);
          await printTaskList(config);
          break;
        case '/submit': case '/s': {
          let submitTasks: GitHubIssue[];
          try {
            submitTasks = await listTasks(config);
          } catch (err) {
            console.log(chalk.red(`  Could not load tasks: ${(err as Error).message}`));
            break;
          }

          const claimedTasks = submitTasks.filter((t) => getStatus(t) === 'claimed');
          if (claimedTasks.length === 0) {
            console.log(chalk.dim('\n  (no claimed tasks to submit)\n'));
            break;
          }

          let submitIssue: number;
          try {
            submitIssue = await select({
              message: 'Select a task to submit:',
              choices: claimedTasks.map((t) => ({
                name: `#${String(t.number).padEnd(4)} ${colorStatus(getStatus(t))} ${t.title}`,
                value: t.number,
              })),
            });
          } catch {
            break;
          }

          // Agent reviews only — commit is handled by the REPL
          const submitMsg = `Review the current git changes against the acceptance criteria for task #${submitIssue}. List what is complete and what is missing. Do NOT call stage_and_commit.`;
          const prevLen = messages.length;
          messages.push({ role: 'user', content: submitMsg });
          let reviewPassed = false;
          try {
            const response = await runAgentLoop(config, messages);
            console.log('\n' + chalk.green('Techunter:') + ' ' + response + '\n');
            reviewPassed = true;
          } catch (err) {
            messages.splice(prevLen);
            console.error(chalk.red(`\nError: ${(err as Error).message}\n`));
            break;
          }

          if (!reviewPassed) break;

          const dirty = await hasUncommittedChanges();
          const commitLabel = dirty ? 'Yes, commit and push' : 'Yes, push current commits';

          let shouldCommit: boolean;
          try {
            shouldCommit = await select({
              message: dirty ? 'Commit and push these changes?' : 'No uncommitted changes — push anyway?',
              choices: [
                { name: commitLabel, value: true },
                { name: 'No', value: false },
              ],
            });
          } catch {
            break;
          }

          if (!shouldCommit) break;

          let commitMsg: string;
          try {
            commitMsg = await input({ message: 'Commit message:' });
          } catch {
            break;
          }

          if (!commitMsg.trim()) break;

          try {
            process.stdout.write(chalk.dim('  Committing…'));
            await stageAllAndCommit(commitMsg.trim());
            process.stdout.write('\r' + ' '.repeat(20) + '\r');
            console.log(chalk.green(`  Committed and pushed: "${commitMsg.trim()}"\n`));
          } catch (err) {
            process.stdout.write('\r' + ' '.repeat(20) + '\r');
            console.log(chalk.red(`  Failed: ${(err as Error).message}`));
          }
          break;
        }
        case '/close': case '/d':
          await cmdClose(config);
          await printTaskList(config);
          break;
        case '/status': case '/me':
          await cmdStatus(config);
          break;
        default:
          console.log(chalk.yellow(`  Unknown command: ${cmd}  (try /help)`));
      }
      continue;
    }

    // Natural language → agent
    const prevLength = messages.length;
    messages.push({ role: 'user', content: userInput });

    try {
      const response = await runAgentLoop(config, messages);
      console.log('\n' + chalk.green('Techunter:') + ' ' + response + '\n');
    } catch (err) {
      messages.splice(prevLength);
      console.error(chalk.red(`\nError: ${(err as Error).message}\n`));
    }

    await printTaskList(config);
  }
}

main().catch((err: Error) => {
  console.error(chalk.red(`Fatal: ${err.message}`));
  process.exit(1);
});
