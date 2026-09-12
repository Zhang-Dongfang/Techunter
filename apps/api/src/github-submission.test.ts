import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeliveryReview, Project, Task } from '@techunter/core';
import { GitHubService } from './github-service.js';

test('Git tree creation preserves legacy executable modes and honors explicit chmod and binary data', async () => {
  let tree: Array<{ path: string; mode: string }> = [];
  const blobs: Array<{ content: string; encoding: string }> = [];
  const client = { git: {
    getCommit: async () => ({ data: { tree: { sha: 'base-tree' } } }),
    getTree: async () => ({ data: { tree: [{ path: 'run.sh', mode: '100755' }] } }),
    createBlob: async (input: { content: string; encoding: string }) => { blobs.push(input); return { data: { sha: 'blob' } }; },
    createTree: async (input: { tree: typeof tree }) => { tree = input.tree; return { data: { sha: 'tree' } }; },
  } };
  const service = new GitHubService(); Object.defineProperty(service, 'client', { value: async () => client });
  const task = { baseSha: 'base' } as Task, project = { repoOwner: 'test', repoName: 'fixture' } as Project;
  await service.submissionTree(task, project, [{ path: 'run.sh', content: 'echo hello', encoding: 'utf-8' }]);
  assert.equal(tree[0]?.mode, '100755');
  await service.submissionTree(task, project, [
    { path: 'run.sh', content: 'echo hello', encoding: 'utf-8', mode: '100644' },
    { path: 'new.sh', content: 'echo new', encoding: 'utf-8', mode: '100755' },
    { path: 'legacy.txt', content: 'gqCCog==', encoding: 'base64', mode: '100644' },
  ]);
  assert.deepEqual(tree.map(file => file.mode), ['100644', '100755', '100644']);
  assert.equal(blobs.at(-1)?.encoding, 'base64'); assert.equal(blobs.at(-1)?.content, 'gqCCog==');
});

test('resubmission restores reverted edits and deletions while keeping commit ancestry', async () => {
  const base = { 'src/a.ts': 'base A', 'src/b.ts': 'base B', 'src/deleted.ts': 'restore me' };
  const blobs = new Map<string, string>();
  const trees = new Map<string, Record<string, string>>([['base-tree', base]]);
  const commits = new Map([['base', { tree: { sha: 'base-tree' } }]]);
  let head = 'base', serial = 0, pullExists = false;
  const parents: string[][] = [];
  const client = {
    git: {
      getRef: async () => ({ data: { object: { sha: head } } }),
      getCommit: async ({ commit_sha }: { commit_sha: string }) => ({ data: commits.get(commit_sha) }),
      getTree: async () => ({ data: { tree: Object.keys(base).map(path => ({ path, mode: '100644' })) } }),
      createBlob: async ({ content }: { content: string }) => { const sha = `blob-${++serial}`; blobs.set(sha, content); return { data: { sha } }; },
      createTree: async (input: { base_tree: string; tree: Array<{ path: string; sha: string | null }> }) => {
        const tree = { ...trees.get(input.base_tree) };
        for (const file of input.tree) { if (file.sha === null) delete tree[file.path]; else tree[file.path] = blobs.get(file.sha)!; }
        const sha = `tree-${++serial}`; trees.set(sha, tree); return { data: { sha } };
      },
      createCommit: async (input: { tree: string; parents: string[] }) => {
        parents.push(input.parents); const sha = `commit-${++serial}`; commits.set(sha, { tree: { sha: input.tree } }); return { data: { sha } };
      },
      updateRef: async ({ sha, force }: { sha: string; force: boolean }) => { assert.equal(force, false); head = sha; },
    },
    pulls: {
      list: async () => ({ data: pullExists ? [{ html_url: 'https://example.invalid/pull/1' }] : [] }),
      create: async () => { pullExists = true; return { data: { html_url: 'https://example.invalid/pull/1' } }; },
    },
    issues: { update: async () => {}, createComment: async () => {} },
  };
  const service = new GitHubService();
  Object.defineProperty(service, 'client', { value: async () => client });
  const task = { id: 'fixture', title: 'fixture', baseSha: 'base', targetBranch: 'main', githubIssueNumber: 1, assignee: { githubLogin: 'worker' } } as Task;
  const project = { repoOwner: 'test', repoName: 'fixture' } as Project;
  const review = { score: 100, summary: 'fixture', verdict: 'approved' } as DeliveryReview;
  await service.publishSubmission(task, project, [
    { path: 'src/a.ts', content: 'reverted later', encoding: 'utf-8' },
    { path: 'src/deleted.ts', content: null, encoding: 'utf-8' },
    { path: 'src/added.ts', content: 'removed later', encoding: 'utf-8' },
  ], review);
  const firstHead = head;
  await service.publishSubmission(task, project, [{ path: 'src/b.ts', content: 'final B', encoding: 'utf-8' }], review);
  assert.deepEqual(trees.get(commits.get(head)!.tree.sha), { ...base, 'src/b.ts': 'final B' });
  assert.deepEqual(parents, [['base'], [firstHead]]);
});
