import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitHubIssue, TechunterConfig } from '../types.js';

test('review submission reuses an existing PR and still creates one for a first submission', async () => {
  const previousFetch = globalThis.fetch;
  const proxyKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  const previousProxy = proxyKeys.map(key => [key, process.env[key]] as const);
  for (const key of proxyKeys) delete process.env[key];
  let existing = true;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    let body: unknown;
    if (method === 'GET' && url.pathname.endsWith('/pulls')) {
      body = existing ? [{ number: 8, html_url: 'https://example.invalid/pull/8', body: 'Closes #1', base: { ref: 'main' }, head: { ref: 'task-1-worker' } }] : [];
    } else if (method === 'GET' && url.pathname.includes('/branches/')) {
      body = { name: 'main', commit: { sha: 'base' } };
    } else if (method === 'POST' && url.pathname.endsWith('/pulls')) {
      if (existing) return new Response(JSON.stringify({ message: 'PR already exists' }), { status: 422, headers: { 'content-type': 'application/json' } });
      body = { html_url: 'https://example.invalid/pull/8' };
    } else if (method === 'DELETE' && url.pathname.includes('/labels/')) {
      return new Response(null, { status: 204 });
    } else if (method === 'POST' && url.pathname.endsWith('/labels')) {
      body = [{ name: 'techunter:in-review' }];
    } else throw new Error(`Unexpected network request blocked: ${method} ${url.pathname}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const { buildTaskFinalizePlan, executeTaskFinalizePlan } = await import('./task-finalize.js');
    for (const hasExisting of [true, false]) {
      existing = hasExisting; calls.length = 0;
      const plan = buildTaskFinalizePlan({ mode: 'review-submit', issueNumber: 1, branch: 'task-1-worker', targetBranch: 'main', baseBranch: 'main' });
      const result = await executeTaskFinalizePlan({ githubToken: 'fixture-token', github: { owner: 'fixture', repo: 'fixture' } } as TechunterConfig,
        plan, { number: 1, title: 'fixture', body: 'fixture' } as GitHubIssue, 'review');
      assert.deepEqual(result, { ok: true, outcome: { kind: 'review-submit', prUrl: 'https://example.invalid/pull/8', existingPr: hasExisting } });
      assert.equal(calls.some(call => call === 'POST /repos/fixture/fixture/pulls'), !hasExisting);
      assert.equal(calls.some(call => call.includes('/branches/')), !hasExisting);
      assert.ok(calls.includes('POST /repos/fixture/fixture/issues/1/labels'));
    }
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of previousProxy) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
