import { input, password, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { getConfig, setConfig, getConfigPath } from '../lib/config.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_CONEXUS_AUDIENCE,
  DEFAULT_CONEXUS_BASE_URL,
  DEFAULT_CONEXUS_PUBLICATION_SLUG,
  DEFAULT_MODEL,
  MANAGED_DEFAULT_MODEL,
} from '../lib/client.js';
import { loginConexusAccount } from '../lib/conexus-account.js';

async function connectConexus(config: ReturnType<typeof getConfig>) {
  const email = await input({
    message: 'Conexus account email:',
    default: config.conexusAccountEmail,
  });
  const accountPassword = await password({ message: 'Conexus account password:', mask: '*' });
  return loginConexusAccount({
    ...config,
    aiAccessMode: 'conexus',
    aiBaseUrl: DEFAULT_CONEXUS_BASE_URL,
    aiAudience: config.aiAudience ?? DEFAULT_CONEXUS_AUDIENCE,
    aiPublicationSlug: config.aiPublicationSlug ?? DEFAULT_CONEXUS_PUBLICATION_SLUG,
  }, email.trim(), accountPassword);
}

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

  const currentAccessMode = config.aiAccessMode ?? 'direct';
  const currentBaseUrl = config.aiBaseUrl ?? (
    currentAccessMode === 'conexus' ? DEFAULT_CONEXUS_BASE_URL : DEFAULT_BASE_URL
  );
  const currentModel = currentAccessMode === 'conexus'
    ? MANAGED_DEFAULT_MODEL
    : config.aiModel ?? DEFAULT_MODEL;
  const currentAudience = config.aiAudience ?? DEFAULT_CONEXUS_AUDIENCE;
  const currentPublicationSlug = config.aiPublicationSlug ?? DEFAULT_CONEXUS_PUBLICATION_SLUG;
  const currentBaseBranch = config.baseBranch ?? 'main';

  const field = await select({
    message: 'Which setting to change?',
    choices: [
      { name: `Central API          ${chalk.dim(config.centralApiUrl ?? process.env['TECHUNTER_API_URL'] ?? '(not configured)')}`, value: 'centralApiUrl' },
      { name: `GitHub repo          ${chalk.dim(`${config.github.owner}/${config.github.repo}`)}`, value: 'repo' },
      { name: `Base branch          ${chalk.dim(currentBaseBranch)}`, value: 'baseBranch' },
      { name: `AI access mode       ${chalk.dim(currentAccessMode)}`, value: 'aiAccessMode' },
      { name: `AI base URL          ${chalk.dim(currentBaseUrl)}`, value: 'aiBaseUrl' },
      { name: `AI model             ${chalk.dim(currentModel)}`, value: 'aiModel' },
      { name: `Conexus audience     ${chalk.dim(currentAudience)}`, value: 'aiAudience' },
      { name: `Conexus publication  ${chalk.dim(currentPublicationSlug)}`, value: 'aiPublicationSlug' },
      { name: `AI credential        ${chalk.dim('(hidden)')}`, value: 'aiApiKey' },
      { name: `GitHub Token         ${chalk.dim('(hidden)')}`, value: 'githubToken' },
      { name: 'Cancel', value: 'cancel' },
    ],
  });

  if (field === 'cancel') return;

  if (field === 'centralApiUrl') {
    const value = await input({ message: 'Techunter central API URL:', default: config.centralApiUrl ?? process.env['TECHUNTER_API_URL'] });
    const { centralApiOrigin } = await import('../lib/central-api.js');
    setConfig({ centralApiUrl: centralApiOrigin({ ...config, centralApiUrl: value }) });
    console.log(chalk.green('\nCentral API saved.\n'));
  } else if (field === 'aiAccessMode') {
    const value = await select<'conexus' | 'direct'>({
      message: 'AI access mode:',
      choices: [
        { name: 'Conexus managed (Railway default model)', value: 'conexus' },
        { name: 'Direct OpenAI-compatible provider', value: 'direct' },
      ],
    });
    if (value === 'conexus') await connectConexus(config);
    else setConfig({ aiAccessMode: 'direct', aiBaseUrl: DEFAULT_BASE_URL });
    console.log(chalk.green(`\nAI access mode set to: ${value}\n`));
  } else if (field === 'baseBranch') {
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
    if (currentAccessMode === 'conexus') {
      console.log(chalk.yellow('\nConexus mode uses the Railway managed default model; there is no local model setting.\n'));
      return;
    }
    const val = await input({ message: 'AI model name:', default: currentModel });
    if (val.trim()) {
      setConfig({ aiModel: val.trim() });
      console.log(chalk.green(`\nAI model set to: ${val.trim()}\n`));
    }
  } else if (field === 'aiAudience') {
    const val = await input({ message: 'Conexus audience:', default: currentAudience });
    if (val.trim()) {
      setConfig({ aiAudience: val.trim() });
      console.log(chalk.green(`\nConexus audience set to: ${val.trim()}\n`));
    }
  } else if (field === 'aiPublicationSlug') {
    const val = await input({ message: 'Conexus publication slug:', default: currentPublicationSlug });
    if (val.trim()) {
      setConfig({ aiPublicationSlug: val.trim() });
      console.log(chalk.green(`\nConexus publication set to: ${val.trim()}\n`));
    }
  } else if (field === 'aiApiKey') {
    if (currentAccessMode === 'conexus') {
      const connected = await connectConexus(config);
      console.log(chalk.green(`\nConexus account connected: ${connected.conexusAccountEmail}\n`));
      return;
    }
    const val = await password({
      message: 'New AI API Key:',
      mask: '*',
    });
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
