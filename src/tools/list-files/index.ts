import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { globby } from 'globby';
import ignore from 'ignore';
import type { TechunterConfig } from '../../types.js';

export const definition = {
  type: 'function',
  function: {
    name: 'list_files',
    description: 'List file paths in the project. Use this first to orient yourself before searching or reading.',
    parameters: {
      type: 'object',
      properties: {
        glob: {
          type: 'string',
          description: 'Glob pattern to filter results, e.g. "src/**/*.ts". Defaults to all text files.',
        },
      },
      required: [],
    },
  },
} as const;

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.pdf',
  '.zip', '.tar', '.gz', '.exe', '.dll', '.woff', '.woff2', '.ttf',
  '.mp3', '.mp4', '.db', '.sqlite', '.lock',
]);

export async function execute(input: Record<string, unknown>, _config: TechunterConfig): Promise<string> {
  const glob = (input['glob'] as string | undefined) ?? '**/*';
  const cwd = process.cwd();

  const ig = ignore();
  const gitignorePath = path.join(cwd, '.gitignore');
  if (existsSync(gitignorePath)) {
    ig.add(await readFile(gitignorePath, 'utf-8'));
  }
  ig.add(['node_modules', 'dist', '.git', '.next', '__pycache__', 'build', 'coverage']);

  const files = await globby(glob, { cwd, dot: false, onlyFiles: true, gitignore: false });
  const filtered = files.filter((f) => !ig.ignores(f) && !BINARY_EXTENSIONS.has(path.extname(f).toLowerCase()));

  if (filtered.length === 0) return `No files matched: ${glob}`;
  return `${filtered.length} file(s):\n${filtered.join('\n')}`;
}
