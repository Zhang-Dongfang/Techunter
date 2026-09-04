import assert from 'node:assert/strict';
import test from 'node:test';
import { issueGitHubOAuthState, verifyGitHubOAuthState } from './github-oauth-state.js';

const key = 'test-oauth-signing-key-that-is-long-enough';
const sessionTokenHash = 'a'.repeat(64);

test('GitHub OAuth state binds the browser callback to one server session', () => {
  const state = issueGitHubOAuthState(sessionTokenHash, key, 1_000);
  const claims = verifyGitHubOAuthState(state, key, 2_000);
  assert.equal(claims.sessionTokenHash, sessionTokenHash);
  assert.equal(claims.expiresAt, 601_000);
});

test('GitHub OAuth state rejects tampering and expiration', () => {
  const state = issueGitHubOAuthState(sessionTokenHash, key, 1_000);
  assert.throws(() => verifyGitHubOAuthState(`${state}x`, key, 2_000), /signature/);
  assert.throws(() => verifyGitHubOAuthState(state, key, 601_000), /expired/);
});
