import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { globby } from 'globby';
import ignore from 'ignore';
import type { ProjectContext } from '../types.js';

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.rar',
  '.exe', '.dll', '.so', '.dylib',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.wav', '.avi', '.mov',
  '.db', '.sqlite', '.lock',
]);

const ALWAYS_READ = [
  'README.md', 'README.txt', 'README',
  'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml',
  'tsconfig.json', 'vite.config.ts', 'vite.config.js',
  'webpack.config.js', 'rollup.config.js',
  '.env.example', 'docker-compose.yml', 'Dockerfile',
];

const MAX_TOTAL_BYTES = 80_000;
const MAX_FILE_BYTES = 15_000;

async function buildIgnoreFilter(cwd: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore();
  const gitignorePath = path.join(cwd, '.gitignore');

  if (existsSync(gitignorePath)) {
    const content = await readFile(gitignorePath, 'utf-8');
    ig.add(content);
  }

  // Always ignore these
  ig.add(['node_modules', 'dist', '.git', '.next', '__pycache__', '*.pyc', 'build', 'coverage']);

  return ig;
}

async function safeReadFile(filePath: string, maxBytes = MAX_FILE_BYTES): Promise<string | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    if (content.length > maxBytes) {
      return content.slice(0, maxBytes) + `\n... (truncated at ${maxBytes} chars)`;
    }
    return content;
  } catch {
    return null;
  }
}

function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function buildFileTree(files: string[]): string {
  const tree: Record<string, string[]> = {};

  for (const file of files) {
    const dir = path.dirname(file);
    if (!tree[dir]) tree[dir] = [];
    tree[dir].push(path.basename(file));
  }

  const lines: string[] = [];
  const rootFiles = tree['.'] ?? [];
  for (const f of rootFiles) lines.push(f);

  const dirs = Object.keys(tree)
    .filter((d) => d !== '.')
    .sort();

  for (const dir of dirs) {
    lines.push(`${dir}/`);
    for (const f of tree[dir]) {
      lines.push(`  ${f}`);
    }
  }

  return lines.join('\n');
}

function scoreRelevance(filePath: string, keywords: string[]): number {
  const lower = filePath.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) score += 1;
  }
  return score;
}

export async function buildProjectContext(
  cwd: string,
  issueTitle: string,
  issueBody: string
): Promise<ProjectContext> {
  const ig = await buildIgnoreFilter(cwd);

  const allFiles = await globby('**/*', {
    cwd,
    gitignore: false, // We handle ignore ourselves
    dot: false,
    onlyFiles: true,
  });

  const filtered = allFiles.filter((f) => !ig.ignores(f) && !isBinaryFile(f));

  const fileTree = buildFileTree(filtered);

  // Extract keywords from issue title + body for relevance scoring
  const issueText = `${issueTitle} ${issueBody}`.toLowerCase();
  const keywords = issueText
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);

  // Read always-read files first
  const keyFiles: Record<string, string> = {};
  let totalBytes = 0;

  for (const always of ALWAYS_READ) {
    if (totalBytes >= MAX_TOTAL_BYTES) break;
    const fullPath = path.join(cwd, always);
    if (!existsSync(fullPath)) continue;

    const content = await safeReadFile(fullPath);
    if (content !== null) {
      keyFiles[always] = content;
      totalBytes += content.length;
    }
  }

  // Score and pick relevant files (up to 10)
  const scored = filtered
    .filter((f) => !ALWAYS_READ.includes(f) && !ALWAYS_READ.includes(path.basename(f)))
    .map((f) => ({ file: f, score: scoreRelevance(f, keywords) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  for (const { file } of scored) {
    if (totalBytes >= MAX_TOTAL_BYTES) break;
    const fullPath = path.join(cwd, file);
    const content = await safeReadFile(fullPath);
    if (content !== null) {
      keyFiles[file] = content;
      totalBytes += content.length;
    }
  }

  return { fileTree, keyFiles };
}
