import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTaskBranchName, type Project, type Task } from '@techunter/core';
import { GitHubService } from './github-service.js';

const project = { githubRepositoryId: 1, repoOwner: 'test', repoName: 'fixture' } as Project;
const task = { id: 'task', targetBranch: 'main', githubIssueNumber: 12, assignee: { githubLogin: 'worker' },
  latestSubmission: { reviewedTreeSha: 'reviewed-tree' },
  scope: { revision: 2, editablePaths: ['src/feature.ts', 'README.md'], readonlyPaths: [], deniedPaths: [], visibleTests: [], environment: { setupCommands: [], testCommands: [], networkAllowlist: [] } },
} as unknown as Task;

function fixture(options: { treeChanged?: boolean; headChanged?: boolean; outOfScope?: boolean; merged?: boolean; alreadyMerged?: boolean; closed?: boolean; closeFailsOnce?: boolean } = {}) {
  let reads = 0, closes = 0;
  let isMerged = options.alreadyMerged ?? false;
  const merges: Array<Record<string, unknown>> = [];
  const service = new GitHubService();
  const client = {
    git: { async getCommit() { return { data: { tree: { sha: options.treeChanged ? 'unreviewed-tree' : 'reviewed-tree' } } }; } },
    pulls: {
      async get() { reads += 1; return { data: { state: isMerged || options.closed ? 'closed' : 'open', merged: isMerged, changed_files: 1,
        head: { sha: options.headChanged && reads > 1 ? 'new-head' : 'checked-head', ref: makeTaskBranchName(12, 'worker'), repo: { id: 1 } },
        base: { sha: 'base-sha', ref: 'main' },
      } }; },
      listFiles: () => undefined,
      async merge(input: Record<string, unknown>) { merges.push(input); isMerged = options.merged ?? true; return { data: { merged: isMerged } }; },
    },
    issues: { async update() { closes += 1; if (options.closeFailsOnce && closes === 1) throw new Error('Issue temporarily unavailable'); } },
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

test('in-scope changes pushed after review cannot merge or lock an acceptance decision', async () => {
  for (const alreadyMerged of [false, true]) {
    const value = fixture({ treeChanged: true, alreadyMerged });
    let locked = false;
    await assert.rejects(() => value.service.completeTask(task, project, 'https://github.com/test/fixture/pull/8', undefined,
      { treeSha: 'reviewed-tree', beforeMerge: async () => { locked = true; } }), /预审后变化/);
    assert.equal(locked, false);
    assert.equal(value.merges.length, 0);
    assert.equal(value.closes(), 0);
  }
});

test('retry resumes issue closure after the PR was merged without merging again', async () => {
  const value = fixture({ closeFailsOnce: true });
  await assert.rejects(() => value.service.completeTask(task, project, 'https://github.com/test/fixture/pull/8'), /temporarily unavailable/);
  await value.service.completeTask(task, project, 'https://github.com/test/fixture/pull/8');
  assert.equal(value.merges.length, 1);
  assert.equal(value.closes(), 2);
});

test('merged retries still enforce scope and closed unmerged PRs remain rejected', async () => {
  for (const options of [{ closed: true }, { alreadyMerged: true, outOfScope: true }]) {
    const value = fixture(options);
    await assert.rejects(() => value.service.completeTask(task, project, 'https://github.com/test/fixture/pull/8'));
    assert.equal(value.merges.length, 0);
    assert.equal(value.closes(), 0);
  }
});
