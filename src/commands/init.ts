import { input, password, select } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import { createOAuthDeviceAuth } from '@octokit/auth-oauth-device';
import { setConfig, getConfigPath } from '../lib/config.js';
import { ensureLabels } from '../lib/github.js';
import { getRemoteUrl, parseOwnerRepo } from '../lib/git.js';
import type { TechunterConfig } from '../types.js';

async function getGitHubTokenViaPAT(): Promise<{ token: string; clientId?: undefined }> {
  console.log(chalk.dim('\n  Create a token at: https://github.com/settings/tokens/new'));
  console.log(chalk.dim('  Required scopes: repo, read:user\n'));
  const token = await password({
    message: 'GitHub Personal Access Token:',
    mask: '*',
  });
  return { token: token.trim() };
}

const OAUTH_CLIENT_ID = 'Ov23liW4zJ4r2RdZOsCJ';

async function getGitHubTokenViaDeviceFlow(): Promise<{ token: string; clientId: string }> {
  let verificationUri = '';
  let userCode = '';

  const auth = createOAuthDeviceAuth({
    clientType: 'oauth-app',
    clientId: OAUTH_CLIENT_ID,
    scopes: ['repo'],
    onVerification(verification) {
      verificationUri = verification.verification_uri;
      userCode = verification.user_code;

      console.log('');
      console.log(chalk.bold('  1. Open this URL in your browser:'));
      console.log('     ' + chalk.cyan(verificationUri));
      console.log('');
      console.log(chalk.bold('  2. Enter this code:'));
      console.log('     ' + chalk.yellow.bold(userCode));
      console.log('');

      // Try to open the browser automatically
      open(verificationUri).catch(() => {
        // Non-fatal if browser can't be opened
      });
    },
  });

  const spinner = ora('Waiting for authorization in browser...').start();

  let token: string;
  try {
    const result = await auth({ type: 'oauth' });
    token = result.token;
    spinner.succeed('Authorized!');
  } catch (err) {
    spinner.fail('Authorization failed');
    throw err;
  }

  return { token, clientId: OAUTH_CLIENT_ID };
}

export async function initCommand(): Promise<void> {
  console.log(chalk.bold.cyan('\nTechunter — Initial Setup\n'));

  // Auto-detect repo from git remote
  let detectedOwner = '';
  let detectedRepo = '';

  const remoteUrl = await getRemoteUrl();
  if (remoteUrl) {
    const parsed = parseOwnerRepo(remoteUrl);
    if (parsed) {
      detectedOwner = parsed.owner;
      detectedRepo = parsed.repo;
      console.log(chalk.dim(`Detected GitHub repo: ${detectedOwner}/${detectedRepo}\n`));
    }
  }

  // Choose auth method
  const authMethod = await select({
    message: 'How would you like to authenticate with GitHub?',
    choices: [
      {
        name: 'Browser login (OAuth) — open a URL and click Authorize',
        value: 'device',
      },
      {
        name: 'Personal Access Token (PAT) — paste a token from github.com/settings/tokens',
        value: 'pat',
      },
    ],
  });

  let githubToken: string;
  let githubClientId: string | undefined;

  if (authMethod === 'device') {
    const result = await getGitHubTokenViaDeviceFlow();
    githubToken = result.token;
    githubClientId = result.clientId;
  } else {
    const result = await getGitHubTokenViaPAT();
    githubToken = result.token;
  }

  console.log(chalk.dim('\n  Get a PPIO API key at: https://ppio.com → Console → API Keys\n'));
  const aiApiKey = await password({
    message: 'PPIO API Key:',
    mask: '*',
  });

  let owner = detectedOwner;
  let repo = detectedRepo;

  if (!owner || !repo) {
    owner = await input({
      message: 'GitHub repo owner (user or org):',
      required: true,
    });
    repo = await input({
      message: 'GitHub repo name:',
      required: true,
    });
  }

  const detectedDefault = 'main';
  const baseBranch = await input({
    message: 'Main branch to merge PRs into:',
    default: detectedDefault,
  });

  const config: TechunterConfig = {
    githubToken,
    githubClientId,
    aiApiKey: aiApiKey.trim(),
    github: {
      owner: owner.trim(),
      repo: repo.trim(),
      baseBranch: baseBranch.trim() || detectedDefault,
    },
  };

  setConfig(config);

  const spinner = ora('Setting up GitHub labels...').start();
  try {
    await ensureLabels(config);
    spinner.succeed('GitHub labels created');
  } catch (err) {
    spinner.fail('Failed to create labels (check token permissions)');
    console.error(chalk.red(String(err)));
  }

  console.log(chalk.green('\nSetup complete!'));
  console.log(chalk.dim(`Config saved to: ${getConfigPath()}\n`));
}
