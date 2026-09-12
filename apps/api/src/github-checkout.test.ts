import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mock, test } from 'node:test';
import type { Project } from '@techunter/core';
import { GitHubService } from './github-service.js';

test('checkout exchanges one repository permission check for a repository-scoped read-only installation token', async () => {
  Object.assign(process.env, {
    SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture'.repeat(8),
    TECHUNTER_CREDENTIAL_ENCRYPTION_KEY: 'fixture'.repeat(8), GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '7',
    GITHUB_PRIVATE_KEY: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });
  let tokenRequest: unknown;
  const repo = { id: 41, owner: { login: 'owner' }, name: 'one', default_branch: 'main', private: true, permissions: { pull: true } };
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const pathname = decodeURIComponent(new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).pathname);
    if (pathname === '/app/installations/7/access_tokens') {
      tokenRequest = JSON.parse(String(init?.body));
      return Response.json({ token: 'scoped-fixture-token', expires_at: '2099-01-01T00:00:00Z', permissions: { contents: 'read' } });
    }
    if (pathname === '/repositories/41' || pathname === '/repos/owner/one') return Response.json(repo);
    if (pathname === '/repos/owner/one/git/ref/heads/main') return Response.json({ object: { sha: 'frozen' } });
    throw new Error(`Unexpected network request in fixture: ${pathname}`);
  });
  try {
    const authorization = await new GitHubService().checkoutAuthorization({ githubRepositoryId: 41, repoOwner: 'owner', repoName: 'one', sourceBranch: 'main', visibility: 'private' } as Project, 'user-fixture-token');
    assert.equal(authorization.token, 'scoped-fixture-token');
    assert.deepEqual(tokenRequest, { repository_ids: [41], permissions: { contents: 'read' } });
  } finally { mock.restoreAll(); }
});

test('shared project visibility does not authorize archive access without a GitHub user credential', async () => {
  await assert.rejects(() => new GitHubService().materialize({ githubRepositoryId: 41 } as Project), /连接有访问权限/);
});
