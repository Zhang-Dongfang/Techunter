import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  sessionDeadlines,
  shouldTouchSession,
} from './auth.js';

test('Techunter sessions have independent absolute and idle deadlines', () => {
  const now = Date.UTC(2026, 7, 29, 12);
  const deadlines = sessionDeadlines(now);
  assert.equal(Date.parse(deadlines.expiresAt), now + SESSION_ABSOLUTE_TTL_MS);
  assert.equal(Date.parse(deadlines.idleExpiresAt), now + SESSION_IDLE_TTL_MS);
});

test('idle sessions are touched at most once per day', () => {
  const now = Date.UTC(2026, 7, 29, 12);
  assert.equal(shouldTouchSession(new Date(now + 6 * 24 * 60 * 60_000 + 1).toISOString(), now), false);
  assert.equal(shouldTouchSession(new Date(now + 6 * 24 * 60 * 60_000).toISOString(), now), true);
  assert.equal(shouldTouchSession('invalid', now), false);
});
