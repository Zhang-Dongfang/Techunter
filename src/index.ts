#!/usr/bin/env node
import chalk from 'chalk';
import { createInterface } from 'node:readline/promises';
import type Anthropic from '@anthropic-ai/sdk';
import { initCommand } from './commands/init.js';
import { getConfig } from './lib/config.js';
import { listTasks } from './lib/github.js';
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // `tch init` — run setup wizard and exit
  if (args[0] === 'init') {
    try {
      await initCommand();
    } catch (err) {
      console.error(chalk.red(`\nError: ${(err as Error).message}`));
      process.exit(1);
    }
    return;
  }

  // Load config — all other modes require it
  let config: TechunterConfig;
  try {
    config = getConfig();
  } catch (err) {
    console.error(chalk.red(`\n${(err as Error).message}`));
    process.exit(1);
    return; // satisfy TypeScript's definite assignment
  }

  const { owner, repo } = config.github;
  console.log(chalk.bold(`\nTechunter — ${owner}/${repo}`));
  console.log(
    chalk.dim('Describe what you want in natural language. "refresh" reloads tasks. Ctrl+C exits.\n')
  );

  await printTaskList(config);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on('close', () => {
    console.log(chalk.gray('\nGoodbye!'));
    process.exit(0);
  });

  // Persistent conversation history — grows across turns
  const messages: Anthropic.MessageParam[] = [];

  for (;;) {
    let userInput: string;
    try {
      userInput = await rl.question(chalk.cyan('\nYou: '));
    } catch {
      // readline closed (Ctrl+D or similar)
      break;
    }

    userInput = userInput.trim();
    if (!userInput) continue;

    if (userInput === 'refresh') {
      await printTaskList(config);
      continue;
    }

    // Track array length so we can roll back on error
    const prevLength = messages.length;
    messages.push({ role: 'user', content: userInput });

    try {
      const response = await runAgentLoop(config, messages);
      console.log('\n' + chalk.green('Techunter:') + ' ' + response + '\n');
    } catch (err) {
      // Roll back the user message so the conversation stays consistent
      messages.splice(prevLength);
      console.error(chalk.red(`\nError: ${(err as Error).message}\n`));
    }

    // Refresh task list after every AI response
    await printTaskList(config);
  }

  rl.close();
}

main().catch((err: Error) => {
  console.error(chalk.red(`Fatal: ${err.message}`));
  process.exit(1);
});
