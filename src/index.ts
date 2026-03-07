#!/usr/bin/env node
import chalk from 'chalk';
import { input } from '@inquirer/prompts';
import { createRequire } from 'node:module';
import type OpenAI from 'openai';

const _require = createRequire(import.meta.url);
const { version } = _require('../package.json') as { version: string };
import { initCommand } from './commands/init.js';
import { getConfig } from './lib/config.js';
import { runAgentLoop } from './lib/agent.js';
import { renderMarkdown } from './lib/markdown.js';
import {
  printTaskList,
  printMyTasks,
  runRefresh,
  runNew,
  runClose,
  runStatus,
  runReview,
  runSubmit,
  runCode,
  runPick,
} from './lib/commands.js';
import type { TechunterConfig } from './types.js';

// ─── Slash commands ───────────────────────────────────────────────────────────

const COMMANDS: { cmd: string; alias?: string; desc: string }[] = [
  { cmd: '/help',    alias: '/h',  desc: 'Show available commands' },
  { cmd: '/refresh', alias: '/r',  desc: 'Reload the task list' },
  { cmd: '/pick',    alias: '/p',  desc: 'Browse tasks and view details' },
  { cmd: '/new',     alias: '/n',  desc: 'Create a new task interactively' },
  { cmd: '/close',   alias: '/d',  desc: 'Close (delete) a task' },
  { cmd: '/submit',  alias: '/s',  desc: 'Commit, create PR, and mark in-review' },
  { cmd: '/review',  alias: '/rv', desc: 'List tasks waiting for your approval' },
  { cmd: '/status',  alias: '/me', desc: 'Show tasks assigned to you' },
  { cmd: '/code',    alias: '/c',  desc: 'Open Claude Code for the current task branch' },
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

async function runAgent(
  config: TechunterConfig,
  messages: OpenAI.ChatCompletionMessageParam[],
  prompt: string
): Promise<void> {
  const prevLen = messages.length;
  messages.push({ role: 'user', content: prompt });
  try {
    const r = await runAgentLoop(config, messages);
    console.log('\n' + chalk.green('Techunter:') + '\n' + renderMarkdown(r));
  } catch (err) {
    messages.splice(prevLen);
    console.error(chalk.red(`\nError: ${(err as Error).message}\n`));
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
    chalk.bold('Techunter') + chalk.dim(` v${version}`),
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
  await printMyTasks(config);

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

    // Slash commands — hardcoded flows, no AI call
    const cmd = userInput.split(/\s+/)[0].toLowerCase();
    if (cmd.startsWith('/')) {
      switch (cmd) {
        case '/help': case '/h':
          cmdHelp();
          break;
        case '/refresh': case '/r':
          await runRefresh(config);
          break;
        case '/pick': case '/p': {
          const arg = userInput.slice(cmd.length).trim().replace(/^#/, '');
          const preselected = arg ? parseInt(arg, 10) : undefined;
          const result = await runPick(config, Number.isNaN(preselected) ? undefined : preselected);
          if (result && result !== 'Cancelled.') {
            console.log(chalk.green(`\n  ${result}\n`));
          }
          await printTaskList(config);
          break;
        }
        case '/new': case '/n': {
          const result = await runNew(config);
          console.log(chalk.green(`\n  ${result}\n`));
          await printTaskList(config);
          break;
        }
        case '/submit': case '/s': {
          const result = await runSubmit(config);
          console.log('\n' + renderMarkdown(result));
          await printTaskList(config);
          break;
        }
        case '/close': case '/d': {
          const result = await runClose(config);
          console.log(chalk.green(`\n  ${result}\n`));
          await printTaskList(config);
          break;
        }
        case '/review': case '/rv': {
          const result = await runReview(config);
          console.log('\n' + renderMarkdown(result));
          break;
        }
        case '/status': case '/me': {
          const result = await runStatus(config);
          console.log('\n' + renderMarkdown(result));
          break;
        }
        case '/code': case '/c':
          await runCode(config);
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
      console.log('\n' + chalk.green('Techunter:') + '\n' + renderMarkdown(response));
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
