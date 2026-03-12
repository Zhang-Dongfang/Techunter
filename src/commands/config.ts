import { input, password, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { getConfig, setConfig, getConfigPath } from '../lib/config.js';
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../lib/client.js';

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

  const currentBaseUrl = config.aiBaseUrl ?? DEFAULT_BASE_URL;
  const currentModel = config.aiModel ?? DEFAULT_MODEL;
  const currentBaseBranch = config.baseBranch ?? 'main';

  const field = await select({
    message: 'Which setting to change?',
    choices: [
      { name: `GitHub repo          ${chalk.dim(`${config.github.owner}/${config.github.repo}`)}`, value: 'repo' },
      { name: `Base branch          ${chalk.dim(currentBaseBranch)}`, value: 'baseBranch' },
      { name: `AI base URL          ${chalk.dim(currentBaseUrl)}`, value: 'aiBaseUrl' },
      { name: `AI model             ${chalk.dim(currentModel)}`, value: 'aiModel' },
      { name: `AI API Key           ${chalk.dim('(hidden)')}`, value: 'aiApiKey' },
      { name: `GitHub Token         ${chalk.dim('(hidden)')}`, value: 'githubToken' },
      { name: 'Cancel', value: 'cancel' },
    ],
  });

  if (field === 'cancel') return;

  if (field === 'baseBranch') {
    const val = await input({ message: 'Base branch name:', default: currentBaseBranch });
    if (val.trim()) {
      setConfig({ baseBranch: val.trim() });
      console.log(chalk.green(`\nBase branch set to: ${val.trim()}\n`));
    }
  } else if (field === 'repo') {
    const owner = await input({ message: 'GitHub repo owner:', default: config.github.owner });
    const repo = await input({ message: 'GitHub repo name:', default: config.github.repo });
    setConfig({ github: { ...config.github, owner: owner.trim(), repo: repo.trim() } });
    console.log(chalk.green(`\nRepo set to: ${owner.trim()}/${repo.trim()}\n`));
  } else if (field === 'aiBaseUrl') {
    const val = await input({ message: 'AI base URL:', default: currentBaseUrl });
    if (val.trim()) {
      setConfig({ aiBaseUrl: val.trim() });
      console.log(chalk.green(`\nAI base URL set to: ${val.trim()}\n`));
    }
  } else if (field === 'aiModel') {
    const val = await input({ message: 'AI model name:', default: currentModel });
    if (val.trim()) {
      setConfig({ aiModel: val.trim() });
      console.log(chalk.green(`\nAI model set to: ${val.trim()}\n`));
    }
  } else if (field === 'aiApiKey') {
    const val = await password({ message: 'New AI API Key:', mask: '*' });
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
