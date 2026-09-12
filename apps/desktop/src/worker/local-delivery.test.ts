import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, it } from 'vitest';
import type { Project, Task } from '@techunter/core';
import { LocalAgent } from './local-agent';

const exec = promisify(execFile);
const roots: string[] = [];
async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'techunter-delivery-test-'));
  roots.push(root); return root;
}
const git = (cwd: string, args: string[]) => exec('git', args, { cwd, windowsHide: true, timeout: 30_000 });
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('techunter-delivery-test-')) throw new Error('Unexpected cleanup target');
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

it('authenticates lazy blob downloads for worktree creation, task merges and project fast-forwards', async () => {
  const root = await temporaryRoot(), source = path.join(root, 'source');
  await fs.mkdir(source);
  await git(source, ['init', '-b', 'main']);
  await git(source, ['config', 'user.name', 'Fixture']);
  await git(source, ['config', 'user.email', 'fixture@example.invalid']);
  await git(source, ['config', 'uploadpack.allowFilter', 'true']);
  await fs.writeFile(path.join(source, 'file.txt'), 'main content\n');
  await git(source, ['add', '.']); await git(source, ['commit', '-m', 'main']);
  await git(source, ['checkout', '-b', 'feature']);
  await fs.writeFile(path.join(source, 'file.txt'), 'feature content only\n');
  await git(source, ['commit', '-am', 'feature']);
  const featureHead = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim();
  const blob = (await git(source, ['rev-parse', 'HEAD:file.txt'])).stdout.trim();
  await git(source, ['checkout', 'main']);
  const clone = path.join(root, 'clone');
  await git(root, ['clone', '--filter=blob:none', pathToFileURL(source).href, clone]);
  assert.equal((await git(clone, ['config', 'remote.origin.partialclonefilter'])).stdout.trim(), 'blob:none');
  assert.ok((await git(clone, ['rev-list', '--objects', '--all', '--missing=print'])).stdout.includes(`?${blob}`));
  const guard = path.join(root, 'upload-pack.cjs');
  await fs.writeFile(guard, [
    "const {spawn}=require('node:child_process');",
    "if(process.env.GIT_CONFIG_KEY_0 !== 'http.https://github.com/.extraHeader'){console.error('FIXTURE_AUTH_MISSING');process.exit(23);}",
    "const child=spawn('git',['upload-pack',...process.argv.slice(2)],{stdio:'inherit',windowsHide:true});",
    "child.on('exit',code=>process.exit(code??1));",
  ].join('\n'));
  await git(clone, ['config', 'remote.origin.uploadpack', `node '${guard.replaceAll('\\', '/')}'`]);
  const dataRoot = path.join(root, 'agent'); await fs.mkdir(dataRoot);
  await fs.writeFile(path.join(dataRoot, 'projects.json'), JSON.stringify({ version: 1, projects: { fixture: clone } }));
  const agent = new LocalAgent(dataRoot);
  // Only bypass the GitHub URL restriction for the loopback file:// transport.
  Object.defineProperty(agent, 'assertProjectRemote', { value: async () => {} });
  const project = { id: 'fixture', repoOwner: 'fixture', repoName: 'clone', cloneUrl: source, visibility: 'private', defaultBranch: 'main', sourceBranch: 'feature' } as Project;
  const task = { id: 'fixture-task', baseSha: featureHead, workingBranch: 'task-integration',
    scope: { editablePaths: ['file.txt'], readonlyPaths: [], deniedPaths: [], environment: { setupCommands: [], testCommands: [], networkAllowlist: [] } } } as unknown as Task;
  const workspace = await agent.provision(project, task, 'fixture-token');
  assert.equal((await fs.readFile(path.join(workspace.path, 'file.txt'), 'utf8')).trim(), 'feature content only');
  await git(source, ['checkout', '-b', task.workingBranch!, 'feature']);
  await fs.writeFile(path.join(source, 'file.txt'), 'accepted child content\n');
  await git(source, ['commit', '-am', 'child']);
  await agent.provision(project, task, 'fixture-token');
  assert.equal((await fs.readFile(path.join(workspace.path, 'file.txt'), 'utf8')).trim(), 'accepted child content');
  await git(source, ['checkout', 'main']);
  await fs.writeFile(path.join(source, 'file.txt'), 'updated main content\n');
  await git(source, ['commit', '-am', 'main update']);
  assert.equal((await agent.syncProject(project, root, 'fixture-token')).outcome, 'updated');
  assert.equal((await fs.readFile(path.join(clone, 'file.txt'), 'utf8')).trim(), 'updated main content');
  const config = await fs.readFile(path.join(clone, '.git', 'config'), 'utf8');
  assert.ok(!config.includes('fixture-token')); assert.ok(!config.includes('extraHeader'));
});

it('delivers Git-normalized text and encoding without altering partial staging, executable modes or binary bytes', async () => {
  const root = await temporaryRoot(), workspace = path.join(root, 'workspaces', 'fixture');
  await fs.mkdir(workspace, { recursive: true });
  await git(workspace, ['init', '-b', 'main']); await git(workspace, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(workspace, '.gitattributes'), 'file.txt text eol=crlf\nscript.ps1 text working-tree-encoding=UTF-16LE eol=crlf\nimage.bin -text\n');
  await fs.writeFile(path.join(workspace, 'file.txt'), 'first\r\nsecond\r\n');
  await fs.writeFile(path.join(workspace, 'script.ps1'), Buffer.from('Write-Output "old"\r\n', 'utf16le'));
  await git(workspace, ['add', '.']); await git(workspace, ['update-index', '--chmod=+x', 'script.ps1']);
  if (process.platform !== 'win32') await fs.chmod(path.join(workspace, 'script.ps1'), 0o755);
  await git(workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline']);
  const baseSha = (await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim();
  await fs.writeFile(path.join(workspace, 'file.txt'), 'partially staged\r\nsecond\r\n');
  await git(workspace, ['add', 'file.txt']);
  await fs.writeFile(path.join(workspace, 'file.txt'), 'final change\r\nsecond\r\n');
  await fs.writeFile(path.join(workspace, 'script.ps1'), Buffer.from('Write-Output "new"\r\n', 'utf16le'));
  const binary = Buffer.from([0, 255, 13, 10, 128]);
  await fs.writeFile(path.join(workspace, 'image.bin'), binary);
  const indexBefore = await fs.readFile(path.join(workspace, '.git', 'index'));
  const task = { id: 'fixture', baseSha, scope: { editablePaths: ['file.txt', 'script.ps1', 'image.bin'], readonlyPaths: [], deniedPaths: [] } } as unknown as Task;
  const agent = new LocalAgent(root), delivery = await agent.collectChanges(task);
  assert.equal(delivery.files.find(file => file.path === 'file.txt')?.content, 'final change\nsecond\n');
  assert.deepEqual(delivery.files.find(file => file.path === 'script.ps1'), { path: 'script.ps1', content: 'Write-Output "new"\n', encoding: 'utf-8', mode: '100755' });
  assert.deepEqual(Buffer.from(delivery.files.find(file => file.path === 'image.bin')!.content!, 'base64'), binary);
  assert.deepEqual(await fs.readFile(path.join(workspace, '.git', 'index')), indexBefore);
  assert.equal(await fs.readFile(path.join(workspace, 'file.txt'), 'utf8'), 'final change\r\nsecond\r\n');
  assert.equal((await git(workspace, ['show', ':file.txt'])).stdout, 'partially staged\nsecond\n');
  assert.equal((await agent.collectChanges(task)).packageDigest, delivery.packageDigest);
  await fs.writeFile(path.join(workspace, 'file.txt'), 'another change\r\n');
  assert.notEqual((await agent.collectChanges(task)).packageDigest, delivery.packageDigest);
});

it('failed required clean filters reject delivery and leave the user index unchanged', async () => {
  const root = await temporaryRoot(), workspace = path.join(root, 'workspaces', 'fixture');
  await fs.mkdir(workspace, { recursive: true });
  await git(workspace, ['init', '-b', 'main']);
  await fs.writeFile(path.join(workspace, 'file.txt'), 'base');
  await git(workspace, ['add', '.']); await git(workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base']);
  const baseSha = (await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim();
  await fs.writeFile(path.join(workspace, '.gitattributes'), 'file.txt filter=broken\n');
  await git(workspace, ['config', 'filter.broken.clean', 'node -e "process.exit(1)"']);
  await git(workspace, ['config', 'filter.broken.required', 'true']);
  await fs.writeFile(path.join(workspace, 'file.txt'), 'changed');
  const before = await fs.readFile(path.join(workspace, '.git', 'index'));
  const task = { id: 'fixture', baseSha, scope: { editablePaths: ['file.txt', '.gitattributes'], readonlyPaths: [], deniedPaths: [] } } as unknown as Task;
  await assert.rejects(() => new LocalAgent(root).collectChanges(task), /filter.*failed|clean filter/i);
  assert.deepEqual(await fs.readFile(path.join(workspace, '.git', 'index')), before);
});

it('does not silently publish an LFS pointer without uploading its object', async () => {
  const root = await temporaryRoot(), workspace = path.join(root, 'workspaces', 'fixture');
  await fs.mkdir(workspace, { recursive: true }); await git(workspace, ['init', '-b', 'main']);
  await git(workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'base']);
  const baseSha = (await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim();
  await fs.writeFile(path.join(workspace, 'asset.bin'), `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 100\n`);
  const task = { id: 'fixture', baseSha, scope: { editablePaths: ['asset.bin'], readonlyPaths: [], deniedPaths: [] } } as unknown as Task;
  await assert.rejects(() => new LocalAgent(root).collectChanges(task), /Git LFS/);
});
