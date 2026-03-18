import ora from 'ora';
import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import type { TechunterConfig } from '../../types.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { getAuthenticatedUser, isCollaborator, upsertRepoFile } from '../../lib/github.js';
import { generateWiki } from './wiki-generator.js';

const WIKI_PATH = 'TECHUNTER.md';

export const definition = {
  type: 'function',
  function: {
    name: 'update_wiki',
    description:
      'Generate or refresh the project overview document (TECHUNTER.md) by scanning the codebase. ' +
      'The document helps new team members understand what the project does, how it is architected, ' +
      'and how to start contributing. Equivalent to /wiki.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
} as const;

export async function run(_input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const authSpinner = ora('Checking permissions…').start();
  let me: string;
  let allowed: boolean;
  try {
    me = await getAuthenticatedUser(config);
    allowed = await isCollaborator(config, me);
    authSpinner.stop();
  } catch (err) {
    authSpinner.stop();
    return `Error checking permissions: ${(err as Error).message}`;
  }
  if (!allowed) {
    return `Permission denied: only repository collaborators can update the project wiki.`;
  }

  const genSpinner = ora('Analyzing project and generating overview…').start();
  let content: string;
  try {
    content = await generateWiki(config);
    genSpinner.stop();
  } catch (err) {
    genSpinner.stop();
    return `Error generating wiki: ${(err as Error).message}`;
  }

  const divider = chalk.dim('─'.repeat(70));
  console.log('\n' + divider);
  console.log(chalk.bold('  Generated TECHUNTER.md preview'));
  console.log(divider);
  console.log(renderMarkdown(content));
  console.log(divider + '\n');

  let action: string;
  try {
    action = await select({
      message: `Publish to repository as ${WIKI_PATH}?`,
      choices: [
        { name: 'Yes, write to repo', value: 'publish' },
        { name: 'Cancel', value: 'cancel' },
      ],
    });
  } catch {
    return 'Cancelled.';
  }

  if (action === 'cancel') return 'Cancelled.';

  const writeSpinner = ora(`Writing ${WIKI_PATH}…`).start();
  try {
    const url = await upsertRepoFile(config, WIKI_PATH, content, 'docs: update TECHUNTER.md project overview');
    writeSpinner.succeed(`Written: ${url}`);
    console.log('');
    return `TECHUNTER.md updated — ${url}`;
  } catch (err) {
    writeSpinner.fail(`Failed: ${(err as Error).message}`);
    return `Error: ${(err as Error).message}`;
  }
}

export async function execute(_input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const me = await getAuthenticatedUser(config);
  if (!await isCollaborator(config, me)) {
    return `Permission denied: only repository collaborators can update the project wiki.`;
  }

  const content = await generateWiki(config);

  try {
    const url = await upsertRepoFile(config, WIKI_PATH, content, 'docs: update TECHUNTER.md project overview');
    return `TECHUNTER.md updated — ${url}`;
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

export const terminal = true;
