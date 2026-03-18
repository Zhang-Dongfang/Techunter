import ora from 'ora';
import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import { select } from '@inquirer/prompts';
import type { TechunterConfig } from '../../types.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { getAuthenticatedUser, isCollaborator, upsertRepoFile, getRepoFile } from '../../lib/github.js';
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

async function readWikiContent(config: TechunterConfig): Promise<string | null> {
  // Try local file first (fastest)
  try {
    return await readFile(WIKI_PATH, 'utf-8');
  } catch { /* not found locally */ }

  // Fall back to GitHub
  return getRepoFile(config, WIKI_PATH);
}

function printWiki(content: string): void {
  const divider = chalk.dim('─'.repeat(70));
  console.log('\n' + divider);
  console.log(chalk.bold('  TECHUNTER.md'));
  console.log(divider);
  console.log(renderMarkdown(content));
  console.log(divider + '\n');
}

export async function run(_input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  // ── Check if wiki already exists ────────────────────────────────────────────
  const fetchSpinner = ora('Checking for existing wiki…').start();
  const existing = await readWikiContent(config).catch(() => null);
  fetchSpinner.stop();

  // ── Decide what to do ───────────────────────────────────────────────────────
  let action: string;
  try {
    action = await select({
      message: 'TECHUNTER.md — what would you like to do?',
      choices: [
        ...(existing ? [{ name: 'View current wiki', value: 'view' }] : []),
        { name: existing ? 'Regenerate & commit to repo' : 'Generate & commit to repo', value: 'generate' },
        { name: 'Cancel', value: 'cancel' },
      ],
    });
  } catch {
    return 'Cancelled.';
  }

  if (action === 'cancel') return 'Cancelled.';

  // ── View ─────────────────────────────────────────────────────────────────────
  if (action === 'view') {
    printWiki(existing!);
    return 'Displayed TECHUNTER.md.';
  }

  // ── Generate ─────────────────────────────────────────────────────────────────
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

  printWiki(content);

  let confirm: string;
  try {
    confirm = await select({
      message: `Publish to repository as ${WIKI_PATH}?`,
      choices: [
        { name: 'Yes, commit to repo', value: 'publish' },
        { name: 'Cancel', value: 'cancel' },
      ],
    });
  } catch {
    return 'Cancelled.';
  }

  if (confirm === 'cancel') return 'Cancelled.';

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
