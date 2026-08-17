import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { minimatch } from 'minimatch';
import type { Task, TaskScope } from '../shared/contracts.js';
import { config } from './config.js';

export interface PackageFile {
  path: string;
  content: string | null;
  encoding: 'utf-8' | 'base64';
}

interface ManifestEntry {
  path: string;
  kind: 'editable' | 'readonly';
  sha256: string;
}

interface PackageManifest {
  version: 1;
  taskId: string;
  baseSha: string;
  scopeRevision: number;
  sourceRoot: string;
  entries: ManifestEntry[];
  editablePatterns: string[];
  deniedPatterns: string[];
  createdAt: string;
}

function normalizeRelative(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('../') || normalized === '..') {
    throw new Error(`非法工作包路径：${value}`);
  }
  return normalized;
}

function matches(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(file, pattern, { dot: true, nocase: process.platform === 'win32' }));
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

async function expandPatterns(root: string, patterns: string[], denied: string[]): Promise<string[]> {
  if (patterns.length === 0) return [];
  const safePatterns = patterns.map(normalizeRelative);
  return fg(safePatterns, {
    cwd: root,
    onlyFiles: true,
    dot: true,
    unique: true,
    followSymbolicLinks: false,
    ignore: denied,
  });
}

async function assertRegularSource(root: string, relative: string): Promise<string> {
  const absolute = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!absolute.startsWith(prefix)) throw new Error(`工作包文件越出仓库边界：${relative}`);
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`工作包只允许普通文件：${relative}`);
  return absolute;
}

export class WorkspaceService {
  async createPackage(task: Task, repoPath: string, scope: TaskScope): Promise<string> {
    const denied = scope.deniedPaths.map(normalizeRelative);
    const editable = await expandPatterns(repoPath, scope.editablePaths, denied);
    const readonly = (await expandPatterns(repoPath, scope.readonlyPaths, denied))
      .filter((file) => !editable.includes(file));
    if (editable.length === 0) {
      throw new Error('Scope 没有匹配到任何可编辑文件，请先调整任务文件范围。');
    }

    for (const file of [...editable, ...readonly]) {
      if (matches(file, denied)) throw new Error(`禁止文件不能加入工作包：${file}`);
    }

    const packageId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const packageRoot = path.join(config.dataDir, 'workspaces', task.id, packageId);
    const repoRoot = path.join(packageRoot, 'repo');
    const metaRoot = path.join(repoRoot, '.techunter');
    await fs.mkdir(metaRoot, { recursive: true });

    const entries: ManifestEntry[] = [];
    for (const [kind, files] of [['editable', editable], ['readonly', readonly]] as const) {
      for (const relative of files) {
        const source = await assertRegularSource(repoPath, relative);
        const destination = path.join(repoRoot, relative);
        const data = await fs.readFile(source);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, data, { mode: kind === 'readonly' ? 0o444 : 0o644 });
        entries.push({ path: relative.replaceAll('\\', '/'), kind, sha256: sha256(data) });
      }
    }

    const manifest: PackageManifest = {
      version: 1,
      taskId: task.id,
      baseSha: task.baseSha,
      scopeRevision: scope.revision,
      sourceRoot: `${task.projectName}@${task.baseSha || 'working-tree'}`,
      entries,
      editablePatterns: scope.editablePaths,
      deniedPatterns: scope.deniedPaths,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(metaRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    await fs.writeFile(path.join(repoRoot, 'TASK.md'), this.taskMarkdown(task, scope), 'utf8');
    return repoRoot;
  }

  async collectChanges(packagePath: string): Promise<PackageFile[]> {
    const root = path.resolve(packagePath);
    const manifestPath = path.join(root, '.techunter', 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as PackageManifest;
    if (manifest.version !== 1) throw new Error('不支持的工作包 manifest 版本。');

    const baseline = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    const currentFiles = await fg('**/*', {
      cwd: root,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false,
      ignore: ['.techunter/**', 'TASK.md'],
    });

    for (const file of currentFiles) {
      const normalized = normalizeRelative(file);
      if (matches(normalized, manifest.deniedPatterns)) throw new Error(`工作包出现禁止文件：${normalized}`);
      const entry = baseline.get(normalized);
      if (!entry && !matches(normalized, manifest.editablePatterns)) {
        throw new Error(`新增文件不在 editablePaths 内：${normalized}`);
      }
    }

    const changed: PackageFile[] = [];
    let totalBytes = 0;
    for (const entry of manifest.entries) {
      const absolute = path.join(root, entry.path);
      let data: Buffer | null = null;
      try {
        data = await fs.readFile(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (entry.kind === 'readonly') {
        if (!data || sha256(data) !== entry.sha256) throw new Error(`只读文件被修改或删除：${entry.path}`);
        continue;
      }
      if (!data) {
        changed.push({ path: entry.path, content: null, encoding: 'utf-8' });
        continue;
      }
      if (sha256(data) === entry.sha256) continue;
      totalBytes += data.length;
      if (data.length > 2 * 1024 * 1024 || totalBytes > 15 * 1024 * 1024) throw new Error('本次提交文件超过 v0.1 工作包大小限制。');
      const binary = data.includes(0);
      changed.push({
        path: entry.path,
        content: binary ? data.toString('base64') : data.toString('utf8'),
        encoding: binary ? 'base64' : 'utf-8',
      });
    }

    for (const file of currentFiles) {
      const normalized = normalizeRelative(file);
      if (baseline.has(normalized)) continue;
      const data = await fs.readFile(path.join(root, normalized));
      totalBytes += data.length;
      if (data.length > 2 * 1024 * 1024 || totalBytes > 15 * 1024 * 1024) throw new Error('本次提交文件超过 v0.1 工作包大小限制。');
      const binary = data.includes(0);
      changed.push({
        path: normalized,
        content: binary ? data.toString('base64') : data.toString('utf8'),
        encoding: binary ? 'base64' : 'utf-8',
      });
    }
    return changed;
  }

  async applyChanges(packagePath: string, files: PackageFile[]): Promise<void> {
    const root = path.resolve(packagePath);
    const manifest = JSON.parse(
      await fs.readFile(path.join(root, '.techunter', 'manifest.json'), 'utf8'),
    ) as PackageManifest;
    for (const file of files) {
      const relative = normalizeRelative(file.path);
      if (matches(relative, manifest.deniedPatterns) || !matches(relative, manifest.editablePatterns)) {
        throw new Error(`子任务交付超出父任务 editablePaths：${relative}`);
      }
      const destination = path.resolve(root, relative);
      if (!destination.startsWith(`${root}${path.sep}`)) throw new Error(`子任务交付越出父工作包：${relative}`);
      if (file.content === null) {
        await fs.rm(destination, { force: true });
        continue;
      }
      const data = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, data);
    }
  }

  private taskMarkdown(task: Task, scope: TaskScope): string {
    return [
      `# ${task.title}`,
      '',
      task.summary || task.description,
      '',
      '## 验收标准',
      ...task.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`),
      '',
      '## 可编辑文件',
      ...scope.editablePaths.map((file) => `- \`${file}\``),
      '',
      '## 只读上下文',
      ...(scope.readonlyPaths.length ? scope.readonlyPaths.map((file) => `- \`${file}\``) : ['- 无']),
      '',
      '## 建议验证命令',
      ...(scope.environment.testCommands.length
        ? scope.environment.testCommands.map((command) => `- \`${command}\``)
        : ['- 请根据任务补充验证结果']),
      '',
      '> 完成后回到 Techunter 提交。平台只会收集 editablePaths 范围内的改动。',
    ].join('\n');
  }
}
