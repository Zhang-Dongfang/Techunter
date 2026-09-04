import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { globby } from 'globby';
import ignore from 'ignore';
import { minimatch } from 'minimatch';

import type { AgentTool, RepositoryAccess } from './types.js';

const execAsync = promisify(exec);
const DEFAULT_DENIED = [
  '.git/**',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/secrets/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
];
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.pdf',
  '.zip', '.tar', '.gz', '.exe', '.dll', '.woff', '.woff2', '.ttf',
  '.mp3', '.mp4', '.db', '.sqlite', '.lock',
]);

function normalized(relative: string): string {
  const value = relative.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!value || value === '..' || value.startsWith('/') || value.includes('../')) {
    throw new Error(`非法仓库路径：${relative}`);
  }
  return value;
}

function safeGlob(pattern: string): string {
  const value = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!value || value.startsWith('/') || /^[a-z]:\//i.test(value) || value.split('/').includes('..')) {
    throw new Error(`非法仓库 glob：${pattern}`);
  }
  return value;
}

function matches(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(file, pattern, { dot: true, nocase: process.platform === 'win32' }));
}

async function ignoreRules(root: string) {
  const rules = ignore();
  const gitignore = path.join(root, '.gitignore');
  if (existsSync(gitignore)) rules.add(await readFile(gitignore, 'utf8'));
  rules.add(['node_modules', 'dist', '.git', '.next', '__pycache__', 'build', 'coverage']);
  return rules;
}

export async function listRepositoryFiles(
  access: RepositoryAccess,
  requestedGlob = '**/*',
): Promise<string[]> {
  const root = path.resolve(access.root);
  const rootRealPath = await realpath(root);
  const denied = [...DEFAULT_DENIED, ...(access.deniedPatterns ?? [])].map(safeGlob);
  const visiblePatterns = [...(access.editablePatterns ?? []), ...(access.readonlyPatterns ?? [])].map(safeGlob);
  const safeRequestedGlob = safeGlob(requestedGlob);
  const searchPatterns = visiblePatterns.length ? visiblePatterns : [safeRequestedGlob];
  const rules = await ignoreRules(root);
  const files = await globby(searchPatterns, {
    cwd: root,
    dot: true,
    onlyFiles: true,
    gitignore: false,
    followSymbolicLinks: false,
    ignore: denied,
  });
  const candidates = [...new Set(files.map(normalized))]
    .filter((file) => !rules.ignores(file))
    .filter((file) => !matches(file, denied))
    .filter((file) => visiblePatterns.length === 0 || matches(file, visiblePatterns))
    .filter((file) => minimatch(file, safeRequestedGlob, { dot: true, nocase: process.platform === 'win32' }))
    .filter((file) => !BINARY_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .sort();
  const visibleFiles: string[] = [];
  for (const file of candidates) {
    try {
      const fileRealPath = await realpath(path.resolve(root, file));
      if (fileRealPath === rootRealPath || fileRealPath.startsWith(`${rootRealPath}${path.sep}`)) visibleFiles.push(file);
    } catch {
      // Ignore files that disappeared while scanning or symlinks escaping the repository.
    }
  }
  return visibleFiles;
}

export async function listFilesTool(access: RepositoryAccess, input: Record<string, unknown>): Promise<string> {
  const requestedGlob = typeof input['glob'] === 'string' ? input['glob'] : '**/*';
  const files = await listRepositoryFiles(access, requestedGlob);
  return files.length ? `${files.length} file(s):\n${files.join('\n')}` : `No files matched: ${requestedGlob}`;
}

export async function grepCodeTool(access: RepositoryAccess, input: Record<string, unknown>): Promise<string> {
  const pattern = typeof input['pattern'] === 'string' ? input['pattern'] : '';
  const fileGlob = typeof input['file_glob'] === 'string' ? input['file_glob'] : '**/*';
  const requestedContext = Number(input['context_lines'] ?? 2);
  const requestedMax = Number(input['max_results'] ?? 50);
  const contextLines = Number.isFinite(requestedContext) ? Math.max(0, Math.min(requestedContext, 5)) : 2;
  const maxResults = Number.isFinite(requestedMax) ? Math.max(1, Math.min(requestedMax, 200)) : 50;
  const startLine = typeof input['start_line'] === 'number' ? input['start_line'] : undefined;
  const endLine = typeof input['end_line'] === 'number' ? input['end_line'] : undefined;
  const files = await listRepositoryFiles(access, fileGlob);

  if (!pattern && startLine !== undefined && endLine !== undefined) {
    if (files.length === 0) return `No file matched: ${fileGlob}`;
    if (files.length > 1) return `file_glob matched ${files.length} files — narrow it to one file.`;
    const content = await readFile(path.join(path.resolve(access.root), files[0]!), 'utf8');
    const lines = content.split('\n');
    const from = Math.max(1, startLine);
    const to = Math.min(lines.length, endLine, from + 299);
    const excerpt = lines.slice(from - 1, to).map((line, index) => `${String(from + index).padStart(5)}: ${line}`).join('\n');
    return `${files[0]} — lines ${from}–${to} of ${lines.length}:\n\`\`\`\n${excerpt}\n\`\`\``;
  }
  if (!pattern) return 'Provide pattern, or start_line + end_line for read-range mode.';

  let regex: RegExp;
  try { regex = new RegExp(pattern, 'i'); }
  catch { regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  const sections: string[] = [];
  let hits = 0;
  for (const file of files) {
    if (hits >= maxResults) break;
    let content: string;
    try { content = await readFile(path.join(path.resolve(access.root), file), 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    const matchedLines = lines.map((line, index) => regex.test(line) ? index : -1).filter((index) => index >= 0);
    if (!matchedLines.length) continue;
    const snippets: string[] = [];
    for (const index of matchedLines) {
      if (hits >= maxResults) break;
      const from = Math.max(0, index - contextLines);
      const to = Math.min(lines.length - 1, index + contextLines);
      snippets.push(lines.slice(from, to + 1).map((line, offset) => {
        const lineNumber = from + offset + 1;
        return `${lineNumber === index + 1 ? '>' : ' '} ${String(lineNumber).padStart(4)}: ${line}`;
      }).join('\n'));
      hits += 1;
    }
    sections.push(`## ${file}\n\`\`\`\n${snippets.join('\n---\n')}\n\`\`\``);
  }
  return sections.length
    ? [`Found matches in ${sections.length} file(s) (${hits} matches):`, ...sections].join('\n\n')
    : `No matches found for: ${pattern}`;
}

export async function runCommandTool(access: RepositoryAccess, input: Record<string, unknown>): Promise<string> {
  if (!access.allowCommands) return 'Command execution is disabled in this Agent context.';
  const command = typeof input['command'] === 'string' ? input['command'].trim() : '';
  if (!command) return 'Command is required.';
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: path.resolve(access.root),
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    return output ? output.slice(0, 8_000) : '(no output)';
  } catch (error) {
    const caught = error as Error & { stdout?: string; stderr?: string; code?: number };
    const output = [caught.stdout, caught.stderr].filter(Boolean).join('\n').trim();
    return `Exit ${caught.code ?? 1}:\n${(output || caught.message).slice(0, 8_000)}`;
  }
}

export function createRepositoryTools(access: RepositoryAccess): AgentTool[] {
  const tools: AgentTool[] = [
    {
      definition: {
        type: 'function',
        function: {
          name: 'list_files',
          description: 'List visible text files in the current project. Use this first.',
          parameters: { type: 'object', properties: { glob: { type: 'string' } }, required: [] },
        },
      },
      execute: (input) => listFilesTool(access, input),
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'grep_code',
          description: 'Search visible source files, or read a precise line range from one file.',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
              file_glob: { type: 'string' },
              context_lines: { type: 'number' },
              max_results: { type: 'number' },
              start_line: { type: 'number' },
              end_line: { type: 'number' },
            },
            required: [],
          },
        },
      },
      execute: (input) => grepCodeTool(access, input),
    },
  ];
  if (access.allowCommands) {
    tools.push({
      definition: {
        type: 'function',
        function: {
          name: 'run_command',
          description: 'Run a build, test, lint, or read-only inspection command in the project root.',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      },
      execute: (input) => runCommandTool(access, input),
    });
  }
  return tools;
}

export const repositoryDefaultDeniedPatterns = DEFAULT_DENIED;
