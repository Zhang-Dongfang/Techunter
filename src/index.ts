#!/usr/bin/env node
import chalk from 'chalk';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import type OpenAI from 'openai';

const _require = createRequire(import.meta.url);
const { version } = _require('../package.json') as { version: string };
import { input } from '@inquirer/prompts';
import { initCommand } from './commands/init.js';
import { configCommand } from './commands/config.js';
import { getConfig, setConfig } from './lib/config.js';
import { getRemoteUrl, parseOwnerRepo } from './lib/git.js';
import { ensureLabels } from './lib/github.js';
import { runAgentLoop } from './lib/agent.js';
import { renderMarkdown } from './lib/markdown.js';
import { printTaskList, printMyTasks } from './lib/display.js';
import { run as runPick } from './tools/pick/index.js';
import { run as runNew } from './tools/new-task/index.js';
import { run as runClose } from './tools/close/index.js';
import { run as runSubmit } from './tools/submit/index.js';
import { run as runStatus } from './tools/my-status/index.js';
import { run as runReview } from './tools/review/index.js';
import { run as runRefresh } from './tools/refresh/index.js';
import { run as runCode } from './tools/open-code/index.js';
import { run as runAccept } from './tools/accept/index.js';
import type { TechunterConfig } from './types.js';

// ─── Tab completion ───────────────────────────────────────────────────────────

const SLASH_NAMES = [
  '/help', '/h', '/refresh', '/r', '/pick', '/p', '/new', '/n',
  '/submit', '/s', '/close', '/d', '/review', '/rv', '/accept', '/ac',
  '/status', '/me', '/code', '/c', '/config', '/cfg', '/init',
];

function completer(line: string): [string[], string] {
  if (line.startsWith('/')) {
    const hits = SLASH_NAMES.filter((c) => c.startsWith(line));
    return [hits.length ? hits : SLASH_NAMES, line];
  }
  return [[], line];
}

let _rl: readline.Interface | null = null;

function promptUser(): Promise<string> {
  return new Promise((resolve) => {
    _rl!.question(chalk.cyan('You') + chalk.dim(' › '), resolve);
  });
}

// ─── Slash commands ───────────────────────────────────────────────────────────

const COMMANDS: { cmd: string; alias?: string; desc: string }[] = [
  { cmd: '/help',    alias: '/h',  desc: 'Show available commands' },
  { cmd: '/refresh', alias: '/r',  desc: 'Reload the task list' },
  { cmd: '/pick',    alias: '/p',  desc: 'Browse tasks and view details' },
  { cmd: '/new',     alias: '/n',  desc: 'Create a new task interactively' },
  { cmd: '/close',   alias: '/d',  desc: 'Close (delete) a task' },
  { cmd: '/submit',  alias: '/s',  desc: 'Commit, create PR, and mark in-review' },
  { cmd: '/review',  alias: '/rv', desc: 'List tasks waiting for your approval' },
  { cmd: '/accept',  alias: '/ac', desc: 'Accept a reviewed task: merge PR and close issue' },
  { cmd: '/config',  alias: '/cfg', desc: 'Change settings (branch, repo, API keys)' },
  { cmd: '/init',                  desc: 'Re-run setup wizard for this repo' },
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

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner(config: TechunterConfig): void {
  const { owner, repo } = config.github;
  const g = chalk.cyan;          // guard / box
  const b = chalk.bold.white;    // blade
  const p = chalk.yellow.bold;   // pommel

  //      ╔═══════════════╗
  //  ◆═══╬   TECHUNTER   ╬═══▶
  //      ╚═══════════════╝
  console.log('');
  console.log('    ' + g('╔═══════════════╗'));
  console.log(p('◆') + b('═══') + g('╬') + b('   TECHUNTER   ') + g('╬') + b('═══▶'));
  console.log('    ' + g('╚═══════════════╝'));
  console.log('');
  console.log(
    '    ' +
    chalk.bold('Techunter') + chalk.dim(` v${version}`) +
    chalk.dim('  ·  ') +
    chalk.cyan('GLM-5') + chalk.dim(' · zai-org') +
    chalk.dim('  ·  ') +
    chalk.dim(`${owner}/${repo}`)
  );
  console.log('');
}

// ─── New-repo init ────────────────────────────────────────────────────────────

async function initNewRepo(config: TechunterConfig, owner: string, repo: string): Promise<TechunterConfig> {
  console.log('');
  console.log(chalk.bold.cyan(`  New repo detected: ${owner}/${repo}`));
  console.log(chalk.dim('  Setting up Techunter for this repository...\n'));

  const baseBranch = await input({
    message: 'Main branch to merge PRs into:',
    default: 'main',
  });

  const newConfig: TechunterConfig = {
    ...config,
    github: { owner, repo, baseBranch: baseBranch.trim() || 'main' },
  };

  setConfig({ github: newConfig.github });

  const ora = (await import('ora')).default;
  const spinner = ora('Creating Techunter labels...').start();
  try {
    await ensureLabels(newConfig);
    spinner.succeed('Labels ready');
  } catch (err) {
    spinner.fail(`Could not create labels: ${(err as Error).message}`);
  }

  console.log('');
  return newConfig;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === 'config') {
    try {
      await configCommand();
    } catch (err) {
      console.error(chalk.red(`\nError: ${(err as Error).message}`));
      process.exit(1);
    }
    return;
  }

  let config: TechunterConfig;
  try {
    config = getConfig();
  } catch {
    // First run — no config yet, run setup wizard
    try {
      await initCommand();
      config = getConfig();
    } catch (err) {
      console.error(chalk.red(`\nSetup failed: ${(err as Error).message}`));
      process.exit(1);
      return;
    }
  }

  // Auto-detect repo from current directory's git remote
  const remoteUrl = await getRemoteUrl();
  if (remoteUrl) {
    const detected = parseOwnerRepo(remoteUrl);
    if (detected) {
      const isNewRepo = detected.owner !== config.github.owner || detected.repo !== config.github.repo;
      if (isNewRepo) {
        config = await initNewRepo(config, detected.owner, detected.repo);
      } else {
        config = { ...config, github: { ...config.github, owner: detected.owner, repo: detected.repo } };
      }
    }
  } else if (!config.github.owner) {
    console.error(chalk.red('\nNo git remote found and no repo configured. Run tch init.'));
    process.exit(1);
  }

  printBanner(config);
  console.log(chalk.dim('  Type /help for commands, or describe what you want.\n'));

  await printTaskList(config);
  await printMyTasks(config);

  _rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer,
    terminal: true,
  });
  _rl.on('close', () => {
    console.log(chalk.gray('\nGoodbye!'));
    process.exit(0);
  });
  _rl.on('SIGINT', () => {
    console.log(chalk.gray('\nGoodbye!'));
    process.exit(0);
  });

  const messages: OpenAI.ChatCompletionMessageParam[] = [];

  for (;;) {
    const userInput = (await promptUser()).trim();
    // pause so inquirer tools don't share the same stdin listener
    _rl.pause();

    if (!userInput) continue;

    // Slash commands — hardcoded flows, no AI call
    const cmd = userInput.split(/\s+/)[0].toLowerCase();
    if (cmd.startsWith('/')) {
      switch (cmd) {
        case '/help': case '/h':
          cmdHelp();
          break;
        case '/refresh': case '/r':
          await runRefresh({}, config);
          break;
        case '/pick': case '/p': {
          const arg = userInput.slice(cmd.length).trim().replace(/^#/, '');
          const preselected = arg ? parseInt(arg, 10) : undefined;
          const result = await runPick({ issue_number: Number.isNaN(preselected) ? undefined : preselected }, config);
          if (result && result !== 'Cancelled.') {
            console.log(chalk.green(`\n  ${result}\n`));
          }
          await printTaskList(config);
          break;
        }
        case '/new': case '/n': {
          const result = await runNew({}, config);
          console.log(chalk.green(`\n  ${result}\n`));
          await printTaskList(config);
          break;
        }
        case '/submit': case '/s': {
          const result = await runSubmit({}, config);
          console.log('\n' + renderMarkdown(result));
          await printTaskList(config);
          break;
        }
        case '/close': case '/d': {
          const result = await runClose({}, config);
          console.log(chalk.green(`\n  ${result}\n`));
          await printTaskList(config);
          break;
        }
        case '/review': case '/rv': {
          const result = await runReview({}, config);
          console.log('\n' + renderMarkdown(result));
          break;
        }
        case '/status': case '/me': {
          const result = await runStatus({}, config);
          console.log('\n' + renderMarkdown(result));
          break;
        }
        case '/accept': case '/ac': {
          const arg = userInput.slice(cmd.length).trim().replace(/^#/, '');
          const preselected = arg ? parseInt(arg, 10) : undefined;
          const result = await runAccept({ issue_number: Number.isNaN(preselected) ? undefined : preselected }, config);
          console.log(chalk.green(`\n  ${result}\n`));
          await printTaskList(config);
          break;
        }
        case '/config': case '/cfg':
          await configCommand();
          break;
        case '/init':
          try {
            await initCommand();
            config = getConfig();
            await printTaskList(config);
          } catch (err) {
            console.error(chalk.red(`\nInit failed: ${(err as Error).message}\n`));
          }
          break;
        case '/code': case '/c':
          await runCode({}, config);
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
