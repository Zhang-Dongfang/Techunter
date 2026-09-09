import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTaskBranchName, type Project, type Task } from '@techunter/core';
import { GitHubService } from './github-service.js';

const project = { githubRepositoryId: 1, repoOwner: 'test', repoName: 'fixture' } as Project;
const task = { id: 'task', targetBranch: 'main', githubIssueNumber: 12, assignee: { githubLogin: 'worker' },
  scope: { revision: 2, editablePaths: ['src/feature.ts', 'README.md'], readonlyPaths: [], deniedPaths: [], visibleTests: [], environment: { setupCommands: [], testCommands: [], networkAllowlist: [] } },
} as unknown as Task;

function fixture(options: { headChanged?: boolean; outOfScope?: boolean; merged?: boolean } = {}) {
  let reads = 0, closes = 0;
  const merges: Array<Record<string, unknown>> = [];
  const service = new GitHubService();
  const client = {
    pulls: {
      async get() { reads += 1; return { data: { state: 'open', changed_files: 1,
        head: { sha: options.headChanged && reads > 1 ? 'new-head' : 'checked-head', ref: makeTaskBranchName(12, 'worker'), repo: { id: 1 } },
        base: { sha: 'base-sha', ref: 'main' },
      } }; },
      listFiles: () => undefined,
      async merge(input: Record<string, unknown>) { merges.push(input); return { data: { merged: options.merged ?? true } }; },
    },
    issues: { async update() { closes += 1; } },
    async paginate() { return [{ filename: options.outOfScope ? 'src/private.ts' : 'README.md' }]; },
  };
  Object.defineProperty(service, 'client', { value: async () => client });
  return { service, merges, closes: () => closes };
}

test('GitHub merge is pinned to the scope-checked head and closes the issue only after a successful merge', async () => {
  const value = fixture();
  await value.service.completeTask(task, project, 'https://github.com/test/fixture/pull/8');
  assert.equal(value.merges[0]?.['sha'], 'checked-head');
  assert.equal(value.closes(), 1);
});

test('concurrent pushes and unauthorized branch changes stop GitHub merge', async () => {
  for (const options of [{ headChanged: true }, { outOfScope: true }]) {
    const value = fixture(options);
    await assert.rejects(() => value.service.completeTask(task, project, 'https://github.com/test/fixture/pull/8'));
    assert.equal(value.merges.length, 0);
    assert.equal(value.closes(), 0);
  }
});

test('an unmerged PR does not advance issue closure or task settlement', async () => {
  const value = fixture({ merged: false });
  await assert.rejects(() => value.service.completeTask(task, project, 'https://github.com/test/fixture/pull/8'), /尚未合并/);
  assert.equal(value.closes(), 0);
});
