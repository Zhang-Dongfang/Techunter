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
  getAuthenticatedUser,
  listMyTasks,
} from './lib/github.js';
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

async function cmdPick(config: TechunterConfig): Promise<void> {
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
      message: 'Select a task:',
      choices: tasks.map((t) => ({
        name: `#${String(t.number).padEnd(4)} ${colorStatus(getStatus(t))} ${t.title}`,
        value: t.number,
      })),
    });
  } catch {
    return;
  }

  try {
    const issue = await getTask(config, chosen);
    printTaskDetail(issue);
  } catch (err) {
    console.log(chalk.red(`  Could not load task: ${(err as Error).message}`));
  }
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

  const { owner, repo } = config.github;
  console.log(chalk.bold(`\nTechunter — ${owner}/${repo}`));
  console.log(chalk.dim('Type /help for commands, or describe what you want in natural language.\n'));

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
        case '/pick': case '/p':
          await cmdPick(config);
          break;
        case '/new': case '/n':
          await cmdNew(config);
          await printTaskList(config);
          break;
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
