import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { expandTaskScope, makeTaskBranchName, type Project, type Task } from '@techunter/core';
import { gitEnvironment, LocalAgent, remoteMatchesProject } from './local-agent.js';

const exec = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => {
    if (path.dirname(path.resolve(target)) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('techunter-local-agent-')) {
      throw new Error('Unexpected test cleanup path');
    }
    return fs.rm(target, { recursive: true, force: true });
  }));
});

describe('LocalAgent', () => {
  it('round-trips non-UTF-8 bytes and preserves executable modes in delivery packages', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'techunter-local-agent-')); cleanup.push(root);
    const workspace = path.join(root, 'workspaces', 'fixture'); await fs.mkdir(workspace, { recursive: true });
    const git = (args: string[]) => exec('git', args, { cwd: workspace });
    await git(['init', '-b', 'main']);
    await fs.writeFile(path.join(workspace, 'run.sh'), '#!/bin/sh\necho old\n');
    await git(['add', '.']); await git(['update-index', '--chmod=+x', 'run.sh']);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base']);
    const task = { id: 'fixture', baseSha: (await git(['rev-parse', 'HEAD'])).stdout.trim(), scope: { editablePaths: ['**'], readonlyPaths: [], deniedPaths: [] } } as unknown as Task;
    const bytes = Buffer.from('82a082a2', 'hex');
    await fs.writeFile(path.join(workspace, 'legacy.txt'), bytes);
    await fs.writeFile(path.join(workspace, 'binary.dat'), Buffer.from([0, 1, 255]));
    await fs.writeFile(path.join(workspace, 'utf8.txt'), '中文🙂');
    await fs.writeFile(path.join(workspace, 'run.sh'), '#!/bin/sh\necho changed\n');
    if (process.platform !== 'win32') await fs.chmod(path.join(workspace, 'run.sh'), 0o755);
    const agent = new LocalAgent(root);
    const changes = await agent.collectChanges(task);
    const legacy = changes.files.find(file => file.path === 'legacy.txt')!;
    expect(legacy.encoding).toBe('base64'); expect(Buffer.from(legacy.content!, 'base64')).toEqual(bytes);
    expect(changes.files.find(file => file.path === 'binary.dat')?.encoding).toBe('base64');
    expect(changes.files.find(file => file.path === 'utf8.txt')).toMatchObject({ encoding: 'utf-8', content: '中文🙂' });
    expect(changes.files.find(file => file.path === 'run.sh')?.mode).toBe('100755');
    await git(['update-index', '--chmod=-x', 'run.sh']);
    if (process.platform !== 'win32') await fs.chmod(path.join(workspace, 'run.sh'), 0o644);
    const demoted = await agent.collectChanges(task);
    expect(demoted.files.find(file => file.path === 'run.sh')?.mode).toBe('100644');
    expect(demoted.packageDigest).not.toBe(changes.packageDigest);
  });

  it('merges accepted child work, rejects stale packages, and preserves conflicting local edits', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'techunter-local-agent-')); cleanup.push(root);
    const source = path.join(root, 'source'); await fs.mkdir(source);
    const git = (args: string[]) => exec('git', args, { cwd: source });
    await git(['init', '-b', 'main']); await git(['config', 'user.name', 'Fixture']); await git(['config', 'user.email', 'fixture@example.invalid']);
    await fs.writeFile(path.join(source, 'parent.txt'), 'old parent'); await fs.writeFile(path.join(source, 'child.txt'), 'old child');
    await git(['add', '.']); await git(['commit', '-m', 'base']);
    const baseSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    await git(['checkout', '-b', makeTaskBranchName(1, 'worker')]);
    await fs.writeFile(path.join(source, 'child.txt'), 'accepted child'); await git(['commit', '-am', 'child accepted']);
    const childHead = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const project = { id: 'project', name: 'fixture', repoOwner: 'local', repoName: 'fixture', cloneUrl: source, defaultBranch: 'main', sourceBranch: 'main', visibility: 'public' } as Project;
    const task = { id: 'task', baseSha, githubIssueNumber: 1, assignee: { githubLogin: 'worker' }, scope: { revision: 1,
      editablePaths: ['parent.txt', 'child.txt'], readonlyPaths: [], deniedPaths: [], visibleTests: [],
      environment: { setupCommands: [], testCommands: ['node -e "console.log(123)"'], networkAllowlist: [] } } } as unknown as Task;
    const agent = new LocalAgent(path.join(root, 'agent')); const synced = await agent.syncProject(project, path.join(root, 'projects'));
    const workspace = await agent.provision(project, task);
    {
      expect(await fs.readFile(path.join(workspace.path, 'child.txt'), 'utf8')).toBe('accepted child');
      await fs.writeFile(path.join(workspace.path, 'parent.txt'), 'local parent');
      const changes = await agent.collectChanges(task);
      expect(changes.headSha).toBe(childHead); expect(changes.files.map(file => file.content)).toContain('accepted child');
      const tests = await agent.test(task); expect(tests.passed).toBe(true); expect(tests.output).toContain('123'); expect(tests.packageDigest).toBe(changes.packageDigest);
      await fs.writeFile(path.join(source, 'child.txt'), 'second child'); await git(['commit', '-am', 'second child']);
      await exec('git', ['fetch', 'origin'], { cwd: synced.path });
      await expect(agent.collectChanges(task)).rejects.toThrow('尚未合入');
      await agent.provision(project, task);
      expect(await fs.readFile(path.join(workspace.path, 'parent.txt'), 'utf8')).toBe('local parent');
      expect(await fs.readFile(path.join(workspace.path, 'child.txt'), 'utf8')).toBe('second child');
      expect((await agent.collectChanges(task)).packageDigest).not.toBe(tests.packageDigest);
    }
    await fs.writeFile(path.join(workspace.path, 'child.txt'), 'unsaved local child');
    await fs.writeFile(path.join(source, 'child.txt'), 'third child'); await git(['commit', '-am', 'third child']);
    await expect(agent.provision(project, task)).rejects.toThrow('处理合并冲突');
    expect(await fs.readFile(path.join(workspace.path, 'child.txt'), 'utf8')).toBe('unsaved local child');
  });

  it('accepts only the exact GitHub repository over HTTPS or SSH', () => {
    const project = { cloneUrl: 'https://github.com/owner/repo.git', repoOwner: 'owner', repoName: 'repo' } as Project;
    for (const remote of ['https://github.com/owner/repo.git', 'git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo.git']) {
      expect(remoteMatchesProject(remote, project)).toBe(true);
    }
    for (const remote of ['https://attacker.invalid/owner/repo.git', 'https://github.com.attacker.invalid/owner/repo.git',
      'https://github.com@attacker.invalid/owner/repo.git', 'http://github.com/owner/repo.git', 'https://github.com:8443/owner/repo.git',
      'git@attacker.invalid:owner/repo.git', 'https://github.com/other/repo.git', 'https://github.com/owner/repo.git?redirect=1']) {
      expect(remoteMatchesProject(remote, project)).toBe(false);
    }
  });

  it('scopes checkout credentials to HTTPS GitHub and disables redirects', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'techunter-local-agent-'));
    cleanup.push(root);
    const options = { cwd: root, env: { ...gitEnvironment({ visibility: 'private' } as Project, 'fixture-token'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-config') } };
    const header = await exec('git', ['config', '--get-urlmatch', 'http.extraHeader', 'https://github.com/owner/repo.git'], options);
    expect(header.stdout.trim()).toBe(`Authorization: Basic ${Buffer.from('x-access-token:fixture-token').toString('base64')}`);
    for (const url of ['https://attacker.invalid/owner/repo.git', 'http://github.com/owner/repo.git']) {
      await expect(exec('git', ['config', '--get-urlmatch', 'http.extraHeader', url], options)).rejects.toMatchObject({ code: 1 });
    }
    expect((await exec('git', ['config', '--get', 'http.followRedirects'], options)).stdout.trim()).toBe('false');
  });

  it('rejects linked directories before reading their contents and still handles deletions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'techunter-local-agent-'));
    cleanup.push(root);
    const workspace = path.join(root, 'agent', 'workspaces', 'fixture');
    const outside = path.join(root, 'outside');
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(workspace, 'src', 'a.ts'), 'base');
    await exec('git', ['init', '-b', 'main'], { cwd: workspace });
    await exec('git', ['add', '.'], { cwd: workspace });
    await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd: workspace });
    const task = { id: 'fixture', baseSha: (await exec('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim(),
      scope: { editablePaths: ['src/**'], readonlyPaths: [], deniedPaths: [] } } as unknown as Task;
    const agent = new LocalAgent(path.join(root, 'agent'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'dummy secret');
    const link = path.join(workspace, 'src', 'linked');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    // Git traverses junctions on Windows and reports a symlink itself on Unix.
    await expect(agent.collectChanges(task)).rejects.toThrow(/链接/);
    await fs.unlink(link);
    await fs.unlink(path.join(workspace, 'src', 'a.ts'));
    expect((await agent.collectChanges(task)).files).toEqual([{ path: 'src/a.ts', content: null, encoding: 'utf-8' }]);
  });

  it('syncs a project and provisions from the selected source branch when no base SHA is frozen', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'techunter-local-agent-'));
    cleanup.push(root);
    const source = path.join(root, 'source');
    await fs.mkdir(path.join(source, 'src'), { recursive: true });
    await fs.writeFile(path.join(source, 'src', 'feature.ts'), 'export const enabled = false;\n');
    await fs.writeFile(path.join(source, 'README.md'), '# fixture\n');
    await exec('git', ['init', '-b', 'main'], { cwd: source });
    await exec('git', ['config', 'user.email', 'test@techunter.local'], { cwd: source });
    await exec('git', ['config', 'user.name', 'Techunter Test'], { cwd: source });
    await exec('git', ['add', '.'], { cwd: source });
    await exec('git', ['commit', '-m', 'fixture'], { cwd: source });
    await exec('git', ['checkout', '-b', 'feature/source-branch'], { cwd: source });
    await fs.writeFile(path.join(source, 'src', 'branch-only.ts'), 'export const branch = true;\n');
    await exec('git', ['add', '.'], { cwd: source });
    await exec('git', ['commit', '-m', 'feature branch fixture'], { cwd: source });
    const headSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim();
    await exec('git', ['checkout', 'main'], { cwd: source });

    const project = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'fixture', repoOwner: 'local', repoName: 'fixture', cloneUrl: source,
      defaultBranch: 'main', sourceBranch: 'feature/source-branch', visibility: 'public', headSha,
    } as Project;
    const task = {
      id: '22222222-2222-4222-8222-222222222222',
      baseSha: '',
      scope: {
        revision: 1,
        editablePaths: ['src/feature.ts'],
        readonlyPaths: ['README.md'],
        deniedPaths: ['**/.env', '.git/**'],
        visibleTests: [],
        environment: { setupCommands: ['node -e "console.log(\'ready\')"'], testCommands: [], networkAllowlist: [] },
      },
    } as unknown as Task;
    const agent = new LocalAgent(path.join(root, 'agent-data'));
    const synced = await agent.syncProject(project, path.join(root, 'projects'));
    expect(synced.outcome).toBe('cloned');
    expect((await agent.locateProject(project.id)).path).toBe(synced.path);
    const result = await agent.provision(project, task);
    expect(result.headSha).toBe(headSha);
    expect(await fs.readFile(path.join(result.path, 'src', 'branch-only.ts'), 'utf8')).toContain('branch');
    expect(result.setupLog).toContain('ready');
    await fs.writeFile(path.join(result.path, 'src', 'feature.ts'), 'export const enabled = true;\n');
    const changes = await agent.collectChanges(task);
    expect(changes.files).toEqual([{ path: 'src/feature.ts', content: 'export const enabled = true;\n', encoding: 'utf-8', mode: '100644' }]);
    await fs.writeFile(path.join(result.path, 'README.md'), '# changed\n');
    await expect(agent.collectChanges(task)).rejects.toThrow('超出任务 editablePaths');
    const approvedTask = { ...task, scope: expandTaskScope(task.scope!, ['README.md']) };
    const approvedChanges = await agent.collectChanges(approvedTask);
    expect(approvedChanges.files.map((file) => file.path)).toEqual(['README.md', 'src/feature.ts']);
    await fs.writeFile(path.join(result.path, 'src', 'branch-only.ts'), 'unauthorized change');
    await expect(agent.collectChanges(approvedTask)).rejects.toThrow('branch-only.ts');
  });
});
