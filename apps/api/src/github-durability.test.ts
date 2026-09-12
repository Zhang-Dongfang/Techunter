import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { DeliveryReview, Project, Task } from '@techunter/core';
import { GitHubService } from './github-service.js';

const project = { repoOwner: 'test', repoName: 'fixture' } as Project;
const task = { id: 'fixture', title: 'fixture', baseSha: 'base', targetBranch: 'main', githubIssueNumber: 1, assignee: { githubLogin: 'worker' } } as Task;
const review = { score: 100, summary: 'fixture', verdict: 'approved' } as DeliveryReview;
function fixture() {
  const base = { 'src/parent.ts': 'old parent', 'src/child.ts': 'old child' };
  const trees = new Map<string, Record<string, string>>([['base-tree', base], ['child-tree', { ...base, 'src/child.ts': 'accepted child' }]]);
  const commits = new Map([['base', { tree: { sha: 'base-tree' } }], ['child-head', { tree: { sha: 'child-tree' } }]]);
  const blobs = new Map<string, string>(), comments: Array<{ body: string }> = [];
  let head = 'child-head', commitCount = 0, losePushResponse = false, pullExists = false, merged = false;
  const client = {
    git: {
      getRef: async () => ({ data: { object: { sha: head } } }),
      getCommit: async ({ commit_sha }: { commit_sha: string }) => ({ data: commits.get(commit_sha) }),
      createBlob: async ({ content }: { content: string }) => { const sha = createHash('sha256').update(content).digest('hex'); blobs.set(sha, content); return { data: { sha } }; },
      createTree: async ({ base_tree, tree }: { base_tree: string; tree: Array<{ path: string; sha: string | null }> }) => {
        const value = { ...trees.get(base_tree) };
        for (const f of tree) { if (f.sha === null) delete value[f.path]; else value[f.path] = blobs.get(f.sha)!; }
        const sha = createHash('sha256').update(JSON.stringify(value)).digest('hex'); trees.set(sha, value); return { data: { sha } };
      },
      createCommit: async ({ tree, parents }: { tree: string; parents: string[] }) => { assert.equal(parents[0], head); const sha = `commit-${++commitCount}`; commits.set(sha, { tree: { sha: tree } }); return { data: { sha } }; },
      updateRef: async ({ sha, force }: { sha: string; force: boolean }) => { assert.equal(force, false); head = sha; if (losePushResponse) { losePushResponse = false; throw new Error('response lost after successful push'); } },
    },
    pulls: {
      list: async () => ({ data: pullExists ? [{ html_url: 'https://example.invalid/pull/1' }] : [] }),
      create: async () => { assert.equal(pullExists, false); pullExists = true; return { data: { html_url: 'https://example.invalid/pull/1' } }; },
    },
    issues: { update: async () => {}, listComments() {}, createComment: async ({ body }: { body: string }) => { comments.push({ body }); } },
    paginate: async (method: unknown) => method === client.pulls.list
      ? (merged ? [{ html_url: 'https://example.invalid/pull/1', merged_at: '2026-09-12', head: { sha: head } }] : []) : comments,
  };
  const service = new GitHubService(); Object.defineProperty(service, 'client', { value: async () => client });
  const operation = { id: 'saved-submission', headSha: 'child-head', checkpoint: async () => {} };
  const files = [{ path: 'src/parent.ts', content: 'new parent', encoding: 'utf-8' as const }, { path: 'src/child.ts', content: 'accepted child', encoding: 'utf-8' as const }];
  return { service, operation, files, loseResponse: () => { losePushResponse = true; }, head: () => head,
    merge: () => { merged = true; pullExists = false; },
    content: () => trees.get(commits.get(head)!.tree.sha), commitCount: () => commitCount, comments };
}

test('stale parent packages are rejected and synchronized submissions preserve accepted child work', async () => {
  const f = fixture();
  await assert.rejects(() => f.service.assertSubmissionHead(task, project, 'base'), /同步/);
  await assert.rejects(() => f.service.publishSubmission(task, project, f.files.slice(0, 1), review, undefined, { ...f.operation, headSha: 'base' }), /远程任务分支已变化/);
  assert.equal(f.head(), 'child-head'); assert.equal(f.commitCount(), 0);
  await f.service.publishSubmission(task, project, f.files, review, undefined, f.operation);
  assert.equal(f.content()?.['src/child.ts'], 'accepted child');
});

test('lost GitHub push responses resume the same snapshot without extra commits, PRs or comments', async () => {
  const f = fixture(); f.loseResponse();
  await assert.rejects(() => f.service.publishSubmission(task, project, f.files, review, undefined, f.operation), /response lost/);
  await f.service.publishSubmission(task, project, f.files, review, undefined, f.operation);
  await f.service.publishSubmission(task, project, f.files, review, undefined, f.operation);
  assert.equal(f.commitCount(), 1); assert.equal(f.comments.length, 1);
});

test('recovery reuses an exact submission PR that was merged during the interruption', async () => {
  const f = fixture();
  await f.service.publishSubmission(task, project, f.files, review, undefined, f.operation);
  f.merge();
  assert.equal(await f.service.publishSubmission(task, project, f.files, review, undefined, f.operation), 'https://example.invalid/pull/1');
  assert.equal(f.commitCount(), 1); assert.equal(f.comments.length, 1);
});

test('publication recovers an Issue after its successful creation response was lost', async () => {
  const issues: Array<{ number: number; html_url: string; body: string; state: string }> = [];
  let creates = 0;
  const client = {
    issues: { listForRepo() {}, update: async () => {}, create: async ({ body }: { body: string }) => {
      creates++; issues.push({ number: 1, html_url: 'https://example.invalid/issues/1', body, state: 'open' });
      throw new Error('issue response lost');
    } },
    paginate: async () => issues,
  };
  const service = new GitHubService();
  Object.defineProperty(service, 'client', { value: async () => client });
  Object.defineProperty(service, 'ensureLabels', { value: async () => {} });
  const draft = { ...task, scope: { editablePaths: ['src/a.ts'], readonlyPaths: [], deniedPaths: [], visibleTests: [], environment: { setupCommands: [], testCommands: [], networkAllowlist: [] } }, acceptanceCriteria: ['works'], rewardPoints: 10 } as unknown as Task;
  await assert.rejects(() => service.createIssue(draft, project), /issue response lost/);
  assert.equal((await service.createIssue(draft, project)).number, 1); assert.equal(creates, 1);
});
