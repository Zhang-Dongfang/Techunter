import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { expandTaskScope, type Project, type Task } from '@techunter/core';
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
    expect(changes.files).toEqual([{ path: 'src/feature.ts', content: 'export const enabled = true;\n', encoding: 'utf-8' }]);
    await fs.writeFile(path.join(result.path, 'README.md'), '# changed\n');
    await expect(agent.collectChanges(task)).rejects.toThrow('超出任务 editablePaths');
    const approvedTask = { ...task, scope: expandTaskScope(task.scope!, ['README.md']) };
    const approvedChanges = await agent.collectChanges(approvedTask);
    expect(approvedChanges.files.map((file) => file.path)).toEqual(['README.md', 'src/feature.ts']);
    await fs.writeFile(path.join(result.path, 'src', 'branch-only.ts'), 'unauthorized change');
    await expect(agent.collectChanges(approvedTask)).rejects.toThrow('branch-only.ts');
  });
});
