import { input, password, select } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import { createOAuthDeviceAuth } from '@octokit/auth-oauth-device';
import { setConfig, getConfigPath } from '../lib/config.js';
import { ensureLabels, upsertRepoFile } from '../lib/github.js';
import { getRemoteUrl, parseOwnerRepo } from '../lib/git.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_CONEXUS_AUDIENCE,
  DEFAULT_CONEXUS_BASE_URL,
  DEFAULT_CONEXUS_PUBLICATION_SLUG,
  DEFAULT_MODEL,
} from '../lib/client.js';
import { detectSvnInfo } from '../lib/svn.js';
import { loginConexusAccount } from '../lib/conexus-account.js';
import type { TechunterConfig, AssetVcsConfig } from '../types.js';
import { generateWiki } from '../tools/wiki/wiki-generator.js';

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

  // AI provider selection
  const providerChoice = await select({
    message: 'AI provider:',
    choices: [
      { name: `Conexus managed  ${chalk.dim('Railway default model')}`, value: 'conexus' },
      { name: `OpenRouter  ${chalk.dim(`${DEFAULT_BASE_URL}  ·  ${DEFAULT_MODEL}`)}`, value: 'openrouter' },
      { name: 'Custom (specify base URL and model)', value: 'custom' },
    ],
  });

  const aiAccessMode = providerChoice === 'conexus' ? 'conexus' : 'direct';
  let aiBaseUrl: string | undefined;
  let aiModel: string | undefined;
  let aiAudience: string | undefined;
  let aiPublicationSlug: string | undefined;
  let conexusEmail = '';
  let conexusPassword = '';

  if (providerChoice === 'conexus') {
    aiBaseUrl = DEFAULT_CONEXUS_BASE_URL;
    aiAudience = (await input({
      message: 'Conexus audience:',
      default: DEFAULT_CONEXUS_AUDIENCE,
    })).trim();
    aiPublicationSlug = (await input({
      message: 'Conexus publication slug:',
      default: DEFAULT_CONEXUS_PUBLICATION_SLUG,
    })).trim();
    conexusEmail = (await input({ message: 'Conexus account email:' })).trim();
    conexusPassword = await password({ message: 'Conexus account password:', mask: '*' });
  } else if (providerChoice === 'custom') {
    aiBaseUrl = (await input({ message: 'API base URL:', default: DEFAULT_BASE_URL })).trim();
    aiModel = (await input({ message: 'Model name:', default: DEFAULT_MODEL })).trim();
  }

  const apiKeyHint = providerChoice === 'openrouter'
      ? chalk.dim('  Get a key at: https://openrouter.ai/settings/keys\n')
      : providerChoice === 'custom'
        ? chalk.dim('  API key for your provider\n')
        : '';
  if (apiKeyHint) console.log(apiKeyHint);
  const aiApiKey = providerChoice === 'conexus'
    ? ''
    : await password({ message: 'API Key:', mask: '*' });

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

  // SVN asset VCS — auto-detect then prompt
  let assetVcs: AssetVcsConfig | undefined;
  const ASSET_PROBE_PATHS = ['.', 'Assets', 'Art', 'Content'];
  let svnInfo: Awaited<ReturnType<typeof detectSvnInfo>> = null;
  let svnDetectedPath = '';
  for (const p of ASSET_PROBE_PATHS) {
    svnInfo = await detectSvnInfo(p);
    if (svnInfo) { svnDetectedPath = p; break; }
  }

  let configureSvn = false;
  if (svnInfo) {
    console.log(chalk.dim(`\nDetected SVN repository: ${svnInfo.url} (in ${svnDetectedPath || '.'})\n`));
    configureSvn = await select({
      message: 'Configure SVN asset locking for binary files (e.g. .psd, .fbx)?',
      choices: [
        { name: 'Yes', value: true },
        { name: 'No, skip', value: false },
      ],
    }).catch(() => false);
  } else {
    configureSvn = await select({
      message: 'Does your team use SVN for binary assets? (optional)',
      choices: [
        { name: 'No, skip', value: false },
        { name: 'Yes, set up SVN locking', value: true },
      ],
    }).catch(() => false);
  }

  if (configureSvn) {
    const svnUrl = svnInfo?.url
      ? (await input({ message: 'SVN repository URL:', default: svnInfo.url })).trim()
      : (await input({ message: 'SVN repository URL:' })).trim();

    const defaultUser = svnInfo?.username ?? '';
    const svnUsername = (await input({
      message: 'SVN username (leave blank to use stored credentials):',
      default: defaultUser,
    })).trim();

    const svnPasswordRaw = await password({
      message: 'SVN password (leave blank to use stored credentials):',
      mask: '*',
    });

    const lockPathsRaw = await input({
      message: 'Paths to lock (comma-separated, relative to working copy):',
      default: svnDetectedPath && svnDetectedPath !== '.' ? svnDetectedPath : 'Assets',
    });

    assetVcs = {
      type: 'svn',
      url: svnUrl,
      ...(svnUsername ? { username: svnUsername } : {}),
      ...(svnPasswordRaw.trim() ? { password: svnPasswordRaw.trim() } : {}),
      lockPaths: lockPathsRaw.split(',').map((s) => s.trim()).filter(Boolean),
    };
  }

  let config: TechunterConfig = {
    githubToken,
    githubClientId,
    aiApiKey: aiApiKey.trim(),
    aiAccessMode,
    ...(aiBaseUrl ? { aiBaseUrl } : {}),
    ...(aiModel ? { aiModel } : {}),
    ...(aiAudience ? { aiAudience } : {}),
    ...(aiPublicationSlug ? { aiPublicationSlug } : {}),
    github: {
      owner: owner.trim(),
      repo: repo.trim(),
    },
    ...(assetVcs ? { assetVcs } : {}),
  };

  if (providerChoice === 'conexus') {
    const spinner = ora('Signing in to Conexus and issuing a Run Ticket...').start();
    try {
      config = await loginConexusAccount(config, conexusEmail, conexusPassword);
      spinner.succeed(`Conexus account connected: ${config.conexusAccountEmail}`);
    } catch (error) {
      spinner.fail('Conexus sign-in failed');
      throw error;
    }
  } else {
    setConfig(config);
  }

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

  let genWiki = false;
  try {
    genWiki = await select({
      message: 'Generate TECHUNTER.md project overview for new team members?',
      choices: [
        { name: 'Yes, generate now', value: true },
        { name: 'No, skip (run /wiki later)', value: false },
      ],
    });
  } catch { /* skip */ }

  if (genWiki) {
    const wikiSpinner = ora('Analyzing project and generating TECHUNTER.md…').start();
    try {
      const content = await generateWiki(config);
      await upsertRepoFile(config, 'TECHUNTER.md', content, 'docs: add TECHUNTER.md project overview');
      wikiSpinner.succeed('TECHUNTER.md created');
    } catch (err) {
      wikiSpinner.fail(`Could not generate wiki: ${(err as Error).message}`);
    }
    console.log('');
  }
}
