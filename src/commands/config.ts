import { input, password, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { getConfig, setConfig, getConfigPath } from '../lib/config.js';

export async function configCommand(): Promise<void> {
  let config;
  try {
    config = getConfig();
  } catch {
    console.error(chalk.red('No config found. Run `tch init` first.'));
    process.exit(1);
  }

  console.log(chalk.bold.cyan('\nTechunter — Settings\n'));
  console.log(chalk.dim(`Config file: ${getConfigPath()}\n`));

  const field = await select({
    message: 'Which setting to change?',
    choices: [
      { name: `Base branch          ${chalk.dim(config.github.baseBranch ?? '(not set, uses repo default)')}`, value: 'baseBranch' },
      { name: `GitHub repo          ${chalk.dim(`${config.github.owner}/${config.github.repo}`)}`, value: 'repo' },
      { name: `AI API Key           ${chalk.dim('(hidden)')}`, value: 'aiApiKey' },
      { name: `GitHub Token         ${chalk.dim('(hidden)')}`, value: 'githubToken' },
      { name: 'Cancel', value: 'cancel' },
    ],
  });

  if (field === 'cancel') return;

  if (field === 'baseBranch') {
    const val = await input({
      message: 'Main branch to merge PRs into:',
      default: config.github.baseBranch ?? 'main',
    });
    setConfig({ github: { ...config.github, baseBranch: val.trim() || 'main' } });
    console.log(chalk.green(`\nBase branch set to: ${val.trim() || 'main'}\n`));
  } else if (field === 'repo') {
    const owner = await input({ message: 'GitHub repo owner:', default: config.github.owner });
    const repo = await input({ message: 'GitHub repo name:', default: config.github.repo });
    setConfig({ github: { ...config.github, owner: owner.trim(), repo: repo.trim() } });
    console.log(chalk.green(`\nRepo set to: ${owner.trim()}/${repo.trim()}\n`));
  } else if (field === 'aiApiKey') {
    const val = await password({ message: 'New PPIO API Key:', mask: '*' });
    if (val.trim()) {
      setConfig({ aiApiKey: val.trim() });
      console.log(chalk.green('\nAI API Key updated.\n'));
    }
  } else if (field === 'githubToken') {
    const val = await password({ message: 'New GitHub Token:', mask: '*' });
    if (val.trim()) {
      setConfig({ githubToken: val.trim() });
      console.log(chalk.green('\nGitHub Token updated.\n'));
    }
  }
}
