import assert from 'node:assert/strict';
import test from 'node:test';
import type { TechunterConfig } from '../types.js';

test('concurrent legacy claims have one winner and a lost response can resume only as that owner', async () => {
  const previousFetch = globalThis.fetch;
  const proxyKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  const proxyValues = proxyKeys.map(key => [key, process.env[key]] as const);
  for (const key of proxyKeys) delete process.env[key];
  let ref: string | undefined, serial = 0, loseUpdate = false;
  const commits = new Map<string, { message: string; tree: { sha: string } }>([['base', { message: 'base', tree: { sha: 'tree' } }]]);
  const issue = { number: 1, state: 'open', body: 'legacy', assignee: null as { login: string } | null, labels: ['techunter:available', 'keep-me'] };
  const winners: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET', route = decodeURIComponent(url.pathname);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === 'GET' && route.endsWith('/issues/1')) return json(issue);
    if (method === 'GET' && route === '/repos/fixture/repo') return json({ default_branch: 'main' });
    if (method === 'GET' && route.endsWith('/git/ref/heads/main')) return json({ object: { sha: 'base' } });
    if (method === 'GET' && route.endsWith('/git/ref/heads/techunter-claims/issue-1')) return json({ object: { sha: ref } });
    if (method === 'GET' && route.includes('/git/commits/')) return json(commits.get(route.split('/').at(-1)!));
    if (method === 'POST' && route.endsWith('/git/commits')) {
      const sha = `commit-${++serial}`; commits.set(sha, { message: body.message, tree: { sha: body.tree } }); return json({ sha });
    }
    if (method === 'POST' && route.endsWith('/git/refs')) {
      if (ref) return json({ message: 'Reference already exists' }, 422);
      ref = body.sha; return json({ ref: body.ref, object: { sha: ref } });
    }
    if (method === 'PATCH' && route.endsWith('/issues/1')) {
      issue.assignee = { login: body.assignees[0] }; issue.labels = body.labels; winners.push(issue.assignee.login);
      if (loseUpdate) { loseUpdate = false; throw new Error('response lost'); }
      return json(issue);
    }
    throw new Error(`Unexpected network request blocked: ${method} ${route}`);
  };
  try {
    const { claimTask } = await import('./github.js');
    const config = { githubToken: 'fixture-token', github: { owner: 'fixture', repo: 'repo' } } as TechunterConfig;
    const attempts = await Promise.allSettled([claimTask(config, 1, 'alice'), claimTask(config, 1, 'bob')]);
    assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(winners.length, 1); assert.deepEqual(issue.labels, ['keep-me', 'techunter:claimed']);
    const owner = issue.assignee!.login;
    // Simulate an interruption after locking but before the Issue is updated.
    issue.assignee = null; issue.labels = ['techunter:available', 'keep-me']; loseUpdate = true;
    await assert.rejects(() => claimTask(config, 1, owner), /response lost/);
    await claimTask(config, 1, owner);
    assert.equal(issue.assignee!.login, owner);
    await assert.rejects(() => claimTask(config, 1, owner === 'alice' ? 'bob' : 'alice'));
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of proxyValues) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
