import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Project, Task } from '@techunter/core';
import { LocalAgent } from './local-agent.js';

const exec = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

describe('LocalAgent', () => {
  it('syncs a project, creates a worktree, runs setup, and enforces editable paths', async () => {
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
    const headSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim();

    const project = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'fixture', repoOwner: 'local', repoName: 'fixture', cloneUrl: source,
      defaultBranch: 'main', visibility: 'public', headSha,
    } as Project;
    const task = {
      id: '22222222-2222-4222-8222-222222222222',
      baseSha: headSha,
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
    expect(result.setupLog).toContain('ready');
    await fs.writeFile(path.join(result.path, 'src', 'feature.ts'), 'export const enabled = true;\n');
    const changes = await agent.collectChanges(task);
    expect(changes.files).toEqual([{ path: 'src/feature.ts', content: 'export const enabled = true;\n', encoding: 'utf-8' }]);
    await fs.writeFile(path.join(result.path, 'README.md'), '# changed\n');
    await expect(agent.collectChanges(task)).rejects.toThrow('超出任务 editablePaths');
  });
});
