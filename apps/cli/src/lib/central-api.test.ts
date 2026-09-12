import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { centralApiOrigin, centralTask, submitCentralTask } from './central-api.js';
import type { GitHubIssue, TechunterConfig } from '../types.js';

const exec = promisify(execFile);
test('central endpoints require an explicit trusted origin', () => {
  for (const centralApiUrl of ['http://remote.invalid', 'https://user:pass@host.invalid', 'https://host.invalid/api', 'https://host.invalid?x=1']) {
    assert.throws(() => centralApiOrigin({ centralApiUrl } as TechunterConfig));
  }
  assert.equal(centralApiOrigin({ centralApiUrl: 'http://127.0.0.1:4310' } as TechunterConfig), 'http://127.0.0.1:4310');
  assert.equal(centralApiOrigin({ centralApiUrl: 'https://central.invalid/' } as TechunterConfig), 'https://central.invalid');
});

test('managed CLI tasks route lifecycle and byte-exact submissions through the API, never GitHub writes', async () => {
  const previousFetch = globalThis.fetch, previousCwd = process.cwd();
  const proxyKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  const proxyValues = proxyKeys.map(key => [key, process.env[key]] as const);
  for (const key of proxyKeys) delete process.env[key];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'techunter-cli-central-'));
  const source = path.join(root, 'source'), checkout = path.join(root, 'checkout');
  await fs.mkdir(source);
  const git = (args: string[], cwd = source) => exec('git', args, { cwd });
  const id = '11111111-1111-4111-8111-111111111111';
  const body = `fixture\n<!-- techunter-task-id:${id} -->`;
  const issue = { number: 1, title: 'fixture', body, labels: ['techunter:claimed'], assignee: 'worker', author: 'publisher' } as GitHubIssue;
  const task = { id, projectId: 'project', githubIssueNumber: 1, status: 'active', baseSha: '', targetBranch: 'main',
    assignee: { id: 'worker-id', githubLogin: 'worker' }, latestSubmission: { id: 'submission', status: 'approved' },
    scope: { revision: 1, editablePaths: ['src/**'], readonlyPaths: [], deniedPaths: [], visibleTests: [], environment: { setupCommands: [], testCommands: [], networkAllowlist: [] } } };
  const config = { centralApiUrl: 'https://central.invalid', centralDeviceId: '22222222-2222-4222-8222-222222222222', aiAccessMode: 'conexus',
    aiApiKey: 'cnx_run_v1.fixture', conexusTicketExpiresAt: new Date(Date.now() + 3600_000).toISOString(), githubToken: 'fixture-token', github: { owner: 'fixture', repo: 'repo' } } as TechunterConfig;
  let identity = 'worker', repoName = 'repo', forbidden = false;
  const writes: Array<{ path: string; method: string; body: any }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
    if (url.hostname === 'api.github.com') {
      assert.equal(method, 'GET', 'central tasks must not write GitHub from the CLI');
      if (url.pathname === '/user') return json({ login: 'worker' });
      if (url.pathname.endsWith('/issues/1')) return json({ ...issue, assignee: { login: 'worker' }, user: { login: 'publisher' }, state: 'open', created_at: '', updated_at: '' });
    }
    if (url.hostname === 'central.invalid') {
      if (url.pathname === '/api/auth/conexus') return json({ session: { expiresAt: new Date(Date.now() + 3600_000).toISOString() } }, 200, { 'set-cookie': 'techunter_session=fixture-session; HttpOnly; Secure; Path=/' });
      assert.equal(new Headers(init?.headers).get('cookie'), 'techunter_session=fixture-session');
      if (method !== 'GET') {
        const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
        writes.push({ path: url.pathname, method, body: payload });
        assert.ok(!JSON.stringify(payload ?? '').includes('fixture-token'));
        if (forbidden) return json({ error: 'forbidden by central policy', code: 'FORBIDDEN' }, 403);
        if (url.pathname.endsWith('/workspaces')) return json({ id: 'workspace' });
        if (url.pathname.endsWith('/submissions') || url.pathname.endsWith('/resume')) return json({ id: 'submission', status: 'approved' });
        return json({ ...task, status: 'accepted' });
      }
      if (url.pathname === '/api/auth/me') return json({ user: { id: 'worker-id', githubLogin: identity }, githubConnected: true });
      if (url.pathname === `/api/tasks/${id}`) return json(task);
      if (url.pathname === '/api/projects/project') return json({ repoOwner: 'fixture', repoName });
    }
    throw new Error(`Unexpected network request blocked: ${method} ${url}`);
  };
  try {
    await git(['init', '-b', 'main']); await fs.mkdir(path.join(source, 'src'));
    await fs.writeFile(path.join(source, 'src', 'a.txt'), 'base'); await git(['add', '.']);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base']);
    task.baseSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    await git(['checkout', '-b', 'task-1-worker']); await git(['clone', source, checkout]);
    process.chdir(checkout);
    const github = await import('./github.js');
    await github.claimTask(config, 1, 'worker');
    const { execute: acceptTask } = await import('../tools/accept/index.js');
    await acceptTask({ issue_number: 1 }, config);
    const { execute: rejectTask } = await import('../tools/reject/index.js');
    await rejectTask({ issue_number: 1, feedback: 'fix the test' }, config);
    await github.closeTask(config, 1);
    assert.deepEqual(writes.map(write => [write.method, write.path]), [
      ['POST', `/api/tasks/${id}/claim`], ['POST', '/api/submissions/submission/accept'],
      ['POST', '/api/submissions/submission/request-changes'], ['DELETE', `/api/tasks/${id}`],
    ]);
    assert.equal(writes[2]!.body.reason, 'fix the test');
    forbidden = true;
    await assert.rejects(() => github.claimTask(config, 1, 'worker'), /forbidden by central/);
    forbidden = false;
    const before = writes.length;
    identity = 'other'; await assert.rejects(() => centralTask(config, issue), /身份与 CLI 不一致/);
    identity = 'worker'; repoName = 'other'; await assert.rejects(() => centralTask(config, issue), /所属仓库不一致/);
    repoName = 'repo'; assert.equal(writes.length, before);
    const bytes = Buffer.from('82a082a2', 'hex'); await fs.writeFile(path.join(checkout, 'src', 'a.txt'), bytes);
    await submitCentralTask(config, issue, 'done', 'actual test log');
    const submission = writes.at(-1)!;
    assert.equal(submission.path, `/api/tasks/${id}/submissions`); assert.equal(submission.body.headSha, task.baseSha);
    assert.deepEqual(Buffer.from(submission.body.files[0].content, 'base64'), bytes);
    assert.equal(submission.body.files[0].mode, '100644'); assert.equal(submission.body.testOutput, 'actual test log');
    assert.equal((await git(['rev-parse', 'HEAD'])).stdout.trim(), task.baseSha, 'remote task branch must not be pushed by CLI submission');
    await fs.writeFile(path.join(checkout, 'private.txt'), 'out of scope');
    const successfulWrites = writes.length;
    await assert.rejects(() => submitCentralTask(config, issue, 'done', ''), /editablePaths/);
    assert.equal(writes.length, successfulWrites);
    task.status = 'submitted'; task.latestSubmission.status = 'reviewing';
    await submitCentralTask(config, issue, 'retry', '');
    assert.equal(writes.at(-1)!.path, '/api/submissions/submission/resume');
  } finally {
    process.chdir(previousCwd); globalThis.fetch = previousFetch;
    for (const [key, value] of proxyValues) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('techunter-cli-central-')) throw new Error('Unexpected cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  }
});
