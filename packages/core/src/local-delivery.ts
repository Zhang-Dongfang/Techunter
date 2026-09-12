import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isTaskPathEditable, normalizeScopePath } from './scope-policy.js';
import { makeTaskBranchName } from './task-conventions.js';
import type { PackageFile, Task } from './platform-types.js';

const execFileAsync = promisify(execFile);

async function repositoryBlob(root: string, relative: string, data: Buffer): Promise<Buffer> {
  // Apply Git's check-in conversion to the already validated bytes. --path selects
  // attributes; stdin avoids rereading a path that could have changed into a link.
  // Writing an unreferenced blob never alters the user's index or worktree.
  const hashed = execFileAsync('git', ['hash-object', '-w', `--path=${relative}`, '--stdin'], {
    cwd: root, timeout: 30_000, windowsHide: true,
  });
  hashed.child.stdin!.on('error', () => {}); // The process rejection reports failed filters.
  hashed.child.stdin!.end(data);
  const sha = (await hashed).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error(`Git 未返回有效的交付对象：${relative}`);
  const blob = await execFileAsync('git', ['cat-file', 'blob', sha], {
    cwd: root, timeout: 30_000, windowsHide: true, encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 + 1,
  });
  if (blob.stdout.toString('utf8', 0, 100).startsWith('version https://git-lfs.github.com/spec/v1\n')) {
    throw new Error(`Git LFS 文件需要单独上传对象，当前交付接口尚不支持：${relative}`);
  }
  return blob.stdout;
}

async function readWorkspaceFile(root: string, relative: string): Promise<Buffer | null> {
  let current = root;
  // Reject aliases even when they point inside the workspace: they can bypass deniedPaths.
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    let stat;
    try { stat = await fsp.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`提交文件不能经过符号链接或目录链接：${relative}`);
  }
  const real = await fsp.realpath(current);
  const resolved = path.relative(root, real);
  if (resolved.startsWith('..') || path.isAbsolute(resolved)) throw new Error(`文件越出工作区：${relative}`);
  const file = await fsp.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await file.stat()).isFile()) throw new Error(`提交路径不是普通文件：${relative}`);
    return await file.readFile();
  } finally { await file.close(); }
}

export async function taskRemoteHead(task: Task, workspacePath: string): Promise<string | null> {
  const branch = task.workingBranch || (task.githubIssueNumber && task.assignee?.githubLogin
    ? makeTaskBranchName(task.githubIssueNumber, task.assignee.githubLogin) : null);
  if (!branch) return null;
  const ref = `refs/remotes/origin/${branch}`;
  try { return (await execFileAsync('git', ['rev-parse', '--verify', ref], { cwd: workspacePath, timeout: 10_000 })).stdout.trim(); }
  catch (error) { if ((error as { code?: number }).code === 128) return null; throw error; }
}

export async function collectTaskChanges(workspacePath: string, task: Task): Promise<{ path: string; files: PackageFile[]; headSha: string; packageDigest: string }> {
  if (!task.scope) throw new Error('任务缺少文件范围。');
  if (!fs.existsSync(workspacePath)) throw new Error('本机没有这个任务的工作环境。');
  if ((await fsp.lstat(workspacePath)).isSymbolicLink()) throw new Error('任务工作区不能是目录链接。');
  const workspaceRealPath = await fsp.realpath(workspacePath);
  const base = task.baseSha || 'HEAD';
  const remoteHead = await taskRemoteHead(task, workspacePath);
  if (remoteHead) {
    try { await execFileAsync('git', ['merge-base', '--is-ancestor', remoteHead, 'HEAD'], { cwd: workspacePath, timeout: 10_000 }); }
    catch { throw new Error('工作区尚未合入远程任务成果，请先同步并处理冲突。'); }
  }
  const headSha = remoteHead || (await execFileAsync('git', ['rev-parse', base], { cwd: workspacePath, timeout: 10_000 })).stdout.trim();
  const [tracked, untracked, index] = await Promise.all([
    execFileAsync('git', ['diff', '--no-renames', '--name-only', '-z', base, '--'], { cwd: workspacePath, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
    execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: workspacePath, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
    execFileAsync('git', ['ls-files', '--stage', '-z'], { cwd: workspacePath, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
  ]);
  const modes = new Map<string, string>();
  for (const entry of index.stdout.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) [a-f0-9]+ (\d)\t([\s\S]+)$/.exec(entry);
    if (!match || match[2] !== '0') throw new Error('工作区包含未解决的 Git 冲突。');
    modes.set(match[3]!, match[1]!);
  }
  const changed = [...new Set(`${tracked.stdout}\0${untracked.stdout}`.split('\0').filter(Boolean).map((file) => {
    const normalized = normalizeScopePath(file);
    if (normalized !== file) throw new Error(`文件名不是规范的任务相对路径：${file}`);
    return normalized;
  }))];
  for (const file of changed) {
    if (!isTaskPathEditable(file, task.scope)) throw new Error(`本机改动超出任务 editablePaths：${file}。请先在任务详情提交范围复议，批准后刷新任务再交付。`);
  }
  const files: PackageFile[] = [];
  let totalBytes = 0;
  for (const relative of changed) {
    const absolute = path.resolve(workspacePath, relative);
    if (!absolute.startsWith(`${path.resolve(workspacePath)}${path.sep}`)) throw new Error(`文件越出工作区：${relative}`);
    const worktreeData = await readWorkspaceFile(workspaceRealPath, relative);
    if (worktreeData === null) { files.push({ path: relative, content: null, encoding: 'utf-8' }); continue; }
    if (worktreeData.length > 2 * 1024 * 1024) throw new Error('提交文件超过大小限制。');
    const data = await repositoryBlob(workspaceRealPath, relative, worktreeData);
    totalBytes += data.length;
    if (data.length > 2 * 1024 * 1024 || totalBytes > 15 * 1024 * 1024) throw new Error('提交文件超过大小限制。');
    const indexedMode = modes.get(relative);
    if (indexedMode && !['100644', '100755'].includes(indexedMode)) throw new Error(`不支持交付该 Git 文件类型：${relative}`);
    const mode = process.platform === 'win32'
      ? (indexedMode === '100755' ? '100755' : '100644')
      : ((await fsp.stat(absolute)).mode & 0o111 ? '100755' : '100644');
    const text = data.toString('utf8');
    const binary = data.includes(0) || !Buffer.from(text, 'utf8').equals(data);
    files.push({ path: relative, content: binary ? data.toString('base64') : text, encoding: binary ? 'base64' : 'utf-8', mode });
  }
  const packageDigest = createHash('sha256').update(JSON.stringify({ headSha, files })).digest('hex');
  return { path: workspacePath, files, headSha, packageDigest };
}
