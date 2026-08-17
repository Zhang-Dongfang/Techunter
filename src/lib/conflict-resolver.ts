import * as fs from 'fs/promises';
import * as nodePath from 'path';
import { simpleGit } from 'simple-git';
import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import { z } from 'zod';
import ora from 'ora';
import { createClient, getModel } from './client.js';
import { hasUncommittedChanges, stash, stashPop } from './git.js';
import type { TechunterConfig } from '../types.js';

const git = simpleGit();

// ─── Conflict parsing ────────────────────────────────────────────────────────

interface ConflictHunk {
  oursLabel: string;
  ours: string;
  theirsLabel: string;
  theirs: string;
  startLine: number; // 0-based index of <<<<<<< line
  endLine: number;   // 0-based index of >>>>>>> line
  before: string;
  after: string;
}

const CONTEXT_LINES = 8;

function parseConflictHunks(content: string): ConflictHunk[] {
  const lines = content.split('\n');
  const hunks: ConflictHunk[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].startsWith('<<<<<<<')) { i++; continue; }

    const startLine = i;
    const oursLabel = lines[i].slice(8).trim();
    i++;

    const oursLines: string[] = [];
    while (i < lines.length && !lines[i].startsWith('=======')) {
      oursLines.push(lines[i]);
      i++;
    }
    i++; // skip =======

    const theirsLines: string[] = [];
    while (i < lines.length && !lines[i].startsWith('>>>>>>>')) {
      theirsLines.push(lines[i]);
      i++;
    }
    const theirsLabel = lines[i]?.slice(8).trim() ?? '';
    const endLine = i;
    i++;

    hunks.push({
      oursLabel,
      ours: oursLines.join('\n'),
      theirsLabel,
      theirs: theirsLines.join('\n'),
      startLine,
      endLine,
      before: lines.slice(Math.max(0, startLine - CONTEXT_LINES), startLine).join('\n'),
      after: lines.slice(endLine + 1, Math.min(lines.length, endLine + 1 + CONTEXT_LINES)).join('\n'),
    });
  }

  return hunks;
}

function applyHunkResolutions(
  content: string,
  resolutions: Array<{ hunk: ConflictHunk; resolved: string }>,
): string {
  const lines = content.split('\n');
  // Bottom-up so earlier line numbers stay valid
  const sorted = [...resolutions].sort((a, b) => b.hunk.startLine - a.hunk.startLine);
  for (const { hunk, resolved } of sorted) {
    lines.splice(hunk.startLine, hunk.endLine - hunk.startLine + 1, ...resolved.split('\n'));
  }
  return lines.join('\n');
}

// ─── LLM resolution ──────────────────────────────────────────────────────────

const resolutionSchema = z.object({
  kind: z.enum(['ours', 'theirs', 'merged', 'manual']),
  reason: z.string(),
  merged: z.string().optional(),
  oursExplanation: z.string().optional(),
  theirsExplanation: z.string().optional(),
});

type LLMResolution = z.infer<typeof resolutionSchema>;

async function resolveHunkWithLLM(
  config: TechunterConfig,
  hunk: ConflictHunk,
  file: string,
  taskContext: string,
): Promise<LLMResolution | null> {
  const client = createClient(config);

  const system = [
    'You are a code merge expert. Analyze this git conflict and choose the best resolution.',
    `Context: ${taskContext}`,
    '',
    'Choices:',
    '  "ours"   — current branch version is correct',
    '  "theirs" — incoming branch version is correct',
    '  "merged" — both changes should coexist; write the combined code in "merged"',
    '  "manual" — semantically ambiguous; explain each side so a human can decide',
    '',
    'Use "manual" only when you genuinely cannot determine intent.',
    'Respond with valid JSON only. No markdown code fences.',
    'Schema: {"kind":"...","reason":"...","merged":"if merged","oursExplanation":"if manual","theirsExplanation":"if manual"}',
  ].join('\n');

  const user = [
    `File: ${file}`,
    '',
    'Context before:',
    hunk.before || '(start of file)',
    '',
    `<<<<<<< ${hunk.oursLabel}  [current]`,
    hunk.ours,
    '=======',
    hunk.theirs,
    `>>>>>>> ${hunk.theirsLabel}  [incoming]`,
    '',
    'Context after:',
    hunk.after || '(end of file)',
  ].join('\n');

  try {
    const res = await client.chat.completions.create({
      model: getModel(config),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
    });
    const raw = res.choices[0]?.message?.content?.trim() ?? '';
    const parsed = resolutionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ─── Interactive UI for ambiguous hunks ──────────────────────────────────────

async function askUserToChoose(
  hunk: ConflictHunk,
  file: string,
  llmResult: LLMResolution | null,
): Promise<string | null> {
  const divider = chalk.dim('─'.repeat(64));

  console.log(`\n${chalk.yellow.bold(`  Conflict — ${chalk.cyan(nodePath.basename(file))}  line ${hunk.startLine + 1}`)}`);
  if (llmResult?.reason) console.log(chalk.dim(`  ${llmResult.reason}\n`));

  console.log(chalk.bold.blue(`  Option A`) + chalk.dim(`  (${hunk.oursLabel})`));
  if (llmResult?.oursExplanation) console.log(chalk.dim(`  ${llmResult.oursExplanation}`));
  console.log(divider);
  console.log(hunk.ours.split('\n').map((l) => '  ' + chalk.green(l)).join('\n'));
  console.log(divider + '\n');

  console.log(chalk.bold.magenta(`  Option B`) + chalk.dim(`  (${hunk.theirsLabel})`));
  if (llmResult?.theirsExplanation) console.log(chalk.dim(`  ${llmResult.theirsExplanation}`));
  console.log(divider);
  console.log(hunk.theirs.split('\n').map((l) => '  ' + chalk.red(l)).join('\n'));
  console.log(divider);

  try {
    const choice = await select({
      message: 'Which version to keep?',
      choices: [
        { name: `A — keep current  (${hunk.oursLabel})`, value: 'ours' },
        { name: `B — use incoming  (${hunk.theirsLabel})`, value: 'theirs' },
      ],
    });
    return choice === 'ours' ? hunk.ours : hunk.theirs;
  } catch {
    return null; // Ctrl+C → abort
  }
}

// ─── Core resolver ────────────────────────────────────────────────────────────

export interface ConflictContext {
  taskTitle?: string;
  sourceBranch: string;
  targetBranch: string;
}

/**
 * Resolve all conflicts in the given files interactively.
 * Assumes the working tree is already in a conflicted merge state.
 * Returns false if the user cancels.
 */
export async function resolveConflictsInteractively(
  config: TechunterConfig,
  conflictFiles: string[],
  ctx: ConflictContext,
): Promise<boolean> {
  const taskContext = [
    ctx.taskTitle ? `Task: "${ctx.taskTitle}"` : '',
    `Merging ${ctx.targetBranch} into ${ctx.sourceBranch}`,
  ].filter(Boolean).join('. ');

  for (const file of conflictFiles) {
    let content: string;
    try {
      content = await fs.readFile(file, 'utf-8');
    } catch {
      console.log(chalk.yellow(`  Cannot read ${file} — skipping`));
      continue;
    }

    const hunks = parseConflictHunks(content);
    if (hunks.length === 0) continue;

    console.log(chalk.bold(`\n  ${chalk.cyan(file)}  (${hunks.length} conflict${hunks.length > 1 ? 's' : ''})`));
    const resolutions: Array<{ hunk: ConflictHunk; resolved: string }> = [];

    for (let idx = 0; idx < hunks.length; idx++) {
      const hunk = hunks[idx];
      const prefix = `  [${idx + 1}/${hunks.length}]`;

      const spinner = ora(`${prefix} Analyzing...`).start();
      const llmResult = await resolveHunkWithLLM(config, hunk, file, taskContext);
      spinner.stop();

      if (!llmResult || llmResult.kind === 'manual') {
        const chosen = await askUserToChoose(hunk, file, llmResult);
        if (chosen === null) return false; // user cancelled
        resolutions.push({ hunk, resolved: chosen });
      } else {
        const resolved =
          llmResult.kind === 'merged' && llmResult.merged != null
            ? llmResult.merged
            : llmResult.kind === 'theirs'
              ? hunk.theirs
              : hunk.ours;
        console.log(chalk.green(`${prefix} Auto-resolved (${llmResult.kind}): ${llmResult.reason}`));
        resolutions.push({ hunk, resolved });
      }
    }

    await fs.writeFile(file, applyHunkResolutions(content, resolutions), 'utf-8');
  }

  return true;
}

// ─── Accept-path helper ───────────────────────────────────────────────────────

/**
 * When GitHub rejects a PR merge (405 conflict), resolve it locally:
 * checkout task branch → merge worker → resolve conflicts → push.
 * Returns true on success, false if cancelled.
 */
export async function resolveAcceptConflict(
  config: TechunterConfig,
  taskBranch: string,
  workerBranch: string,
  taskTitle?: string,
): Promise<boolean> {
  const originalBranch = (await git.branch()).current;
  const needsStash = await hasUncommittedChanges();

  if (needsStash) {
    await stash('auto-stash before conflict resolution');
  }

  try {
    await git.fetch('origin', [taskBranch, workerBranch]);

    // Checkout task branch (create local tracking if needed)
    try {
      await git.checkout(taskBranch);
    } catch {
      await git.checkoutBranch(taskBranch, `origin/${taskBranch}`);
    }

    // Pull latest task branch changes
    await git.pull('origin', taskBranch, ['--ff-only']).catch(() => null);

    // Attempt merge
    let conflictFiles: string[] = [];
    try {
      await git.merge([`origin/${workerBranch}`, '--no-edit']);
    } catch {
      const status = await git.status();
      conflictFiles = status.conflicted;
    }

    if (conflictFiles.length === 0) {
      // Clean merge — push and we're done
      await git.push('origin', taskBranch);
      return true;
    }

    // Resolve conflicts interactively
    console.log(chalk.bold(`\nResolving ${conflictFiles.length} conflicting file(s):`));
    const resolved = await resolveConflictsInteractively(config, conflictFiles, {
      taskTitle,
      sourceBranch: taskBranch,
      targetBranch: workerBranch,
    });

    if (!resolved) {
      // User cancelled — abort merge and restore
      await git.raw(['merge', '--abort']).catch(() => git.raw(['reset', '--merge']));
      return false;
    }

    await git.add('.');
    await git.commit(`chore: resolve merge conflicts — ${taskBranch} ← ${workerBranch}`);
    await git.push('origin', taskBranch);
    return true;
  } finally {
    if (originalBranch && originalBranch !== taskBranch) {
      await git.checkout(originalBranch).catch(() => null);
    }
    if (needsStash) {
      await stashPop().catch(() => null);
    }
  }
}
