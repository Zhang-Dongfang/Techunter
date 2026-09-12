import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTaskVersion } from './task-version.js';

test('root tasks freeze the selected project source branch head', async () => {
  let branchRead = false;
  const version = await resolveTaskVersion(
    { sourceBranch: 'feature/source-branch', headSha: 'a'.repeat(40) },
    null,
    async () => { branchRead = true; return 'unexpected'; },
  );
  assert.deepEqual(version, { baseSha: 'a'.repeat(40), targetBranch: 'feature/source-branch' });
  assert.equal(branchRead, false);
});

test('child tasks freeze the latest parent task branch head', async () => {
  const version = await resolveTaskVersion(
    { sourceBranch: 'feature/source-branch', headSha: 'a'.repeat(40) },
    { githubIssueNumber: 42, assignee: { githubLogin: 'Parent.Owner' } },
    async (branch) => {
      assert.equal(branch, 'task-42-parent-owner');
      return 'b'.repeat(40);
    },
  );
  assert.deepEqual(version, { baseSha: 'b'.repeat(40), targetBranch: 'task-42-parent-owner' });
});

test('child targets survive a parent reassignment and GitHub login changes', async () => {
  const version = await resolveTaskVersion(
    { sourceBranch: 'main', headSha: 'a'.repeat(40) },
    { workingBranch: 'task-stable-id', githubIssueNumber: 42, assignee: { githubLogin: 'new-owner' } },
    async branch => { assert.equal(branch, 'task-stable-id'); return 'b'.repeat(40); },
  );
  assert.deepEqual(version, { baseSha: 'b'.repeat(40), targetBranch: 'task-stable-id' });
});
