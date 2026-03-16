import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { globby } from 'globby';
import ignore from 'ignore';
import type { TechunterConfig } from '../../types.js';

export const definition = {
  type: 'function',
  function: {
    name: 'grep_code',
    description:
      'Search for a pattern across files, or read a specific line range from a file.\n' +
      '- Search mode: provide `pattern` — returns matching lines with context.\n' +
      '- Read-range mode: provide `file_glob` (single file) + `start_line` + `end_line`, no `pattern` — read an exact section. Use after grep has given you line numbers.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regex or plain text to search for (case-insensitive). Omit for read-range mode.',
        },
        file_glob: {
          type: 'string',
          description: 'Glob to restrict which files to search or read, e.g. "src/**/*.ts" or "src/lib/agent.ts". Defaults to all text files.',
        },
        context_lines: {
          type: 'number',
          description: 'Lines of context before/after each match (search mode only). Default: 2.',
        },
        max_results: {
          type: 'number',
          description: 'Max matches to return (search mode only). Default: 50.',
        },
        start_line: {
          type: 'number',
          description: 'First line to read, 1-based (read-range mode). Requires file_glob pointing to a single file.',
        },
        end_line: {
          type: 'number',
          description: 'Last line to read, 1-based (read-range mode).',
        },
      },
      required: [],
    },
  },
} as const;

async function buildIgnore(cwd: string) {
  const ig = ignore();
  const gitignorePath = path.join(cwd, '.gitignore');
  if (existsSync(gitignorePath)) {
    ig.add(await readFile(gitignorePath, 'utf-8'));
  }
  ig.add(['node_modules', 'dist', '.git', '.next', '__pycache__', 'build', 'coverage']);
  return ig;
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.pdf',
  '.zip', '.tar', '.gz', '.exe', '.dll', '.woff', '.woff2', '.ttf',
  '.mp3', '.mp4', '.db', '.sqlite', '.lock',
]);

function isText(f: string) {
  return !BINARY_EXTENSIONS.has(path.extname(f).toLowerCase());
}

const MAX_RANGE_LINES = 300;

export async function execute(input: Record<string, unknown>, _config: TechunterConfig): Promise<string> {
  const pattern = (input['pattern'] as string | undefined) ?? '';
  const fileGlob = (input['file_glob'] as string | undefined) ?? '**/*';
  const contextLines = Math.min((input['context_lines'] as number | undefined) ?? 2, 5);
  const maxResults = Math.min((input['max_results'] as number | undefined) ?? 50, 200);
  const startLine = input['start_line'] as number | undefined;
  const endLine = input['end_line'] as number | undefined;

  const cwd = process.cwd();

  // Read-range mode
  if (!pattern && startLine != null && endLine != null) {
    const files = await globby(fileGlob, { cwd, dot: false, onlyFiles: true, gitignore: false });
    if (files.length === 0) return `No file matched: ${fileGlob}`;
    if (files.length > 1) return `file_glob matched ${files.length} files — narrow it to a single file for read-range mode.`;
    const raw = await readFile(path.join(cwd, files[0]), 'utf-8');
    const lines = raw.split('\n');
    const total = lines.length;
    const from = Math.max(1, startLine);
    const to = Math.min(total, endLine, from + MAX_RANGE_LINES - 1);
    const numbered = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}: ${l}`).join('\n');
    const truncNote = to < Math.min(total, endLine) ? `\n… (use start_line=${to + 1} to continue)` : '';
    return `${files[0]} — lines ${from}–${to} of ${total}:\n\`\`\`\n${numbered}\n\`\`\`${truncNote}`;
  }

  if (!pattern) return 'Provide a `pattern` to search, or `start_line` + `end_line` for read-range mode. Use list_files to browse file paths.';

  // Search mode
  const ig = await buildIgnore(cwd);
  let regex: RegExp;
  try { regex = new RegExp(pattern, 'i'); }
  catch { regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }

  const allFiles = await globby(fileGlob, { cwd, dot: false, onlyFiles: true, gitignore: false });
  const filtered = allFiles.filter((f) => !ig.ignores(f) && isText(f));

  const matches: string[] = [];
  let totalMatches = 0;

  for (const file of filtered) {
    if (totalMatches >= maxResults) break;
    let content: string;
    try { content = await readFile(path.join(cwd, file), 'utf-8'); } catch { continue; }

    const lines = content.split('\n');
    const hitLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) hitLines.push(i);
    }
    if (hitLines.length === 0) continue;

    const ranges: Array<[number, number]> = [];
    for (const hit of hitLines) {
      const s = Math.max(0, hit - contextLines);
      const e = Math.min(lines.length - 1, hit + contextLines);
      if (ranges.length > 0 && s <= ranges[ranges.length - 1][1] + 1) {
        ranges[ranges.length - 1][1] = e;
      } else {
        ranges.push([s, e]);
      }
    }

    const snippets: string[] = [];
    for (const [s, e] of ranges) {
      if (totalMatches >= maxResults) break;
      snippets.push(
        lines.slice(s, e + 1).map((l, i) => {
          const n = s + i + 1;
          return `${regex.test(l) ? '>' : ' '} ${String(n).padStart(4)}: ${l}`;
        }).join('\n')
      );
      totalMatches += hitLines.filter((h) => h >= s && h <= e).length;
    }
    if (snippets.length > 0) {
      matches.push(`## ${file}\n\`\`\`\n${snippets.join('\n---\n')}\n\`\`\``);
    }
  }

  if (matches.length === 0) return `No matches found for: ${pattern}`;
  const header = `Found matches in ${matches.length} file(s) (${totalMatches} match${totalMatches === 1 ? '' : 'es'})${totalMatches >= maxResults ? ' — limit reached' : ''}:`;
  return [header, ...matches].join('\n\n');
}
