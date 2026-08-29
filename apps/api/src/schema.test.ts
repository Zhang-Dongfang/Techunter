import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('Supabase migration owns the shared schema and atomic invariants', () => {
  const migrationRoot = path.resolve(process.cwd(), '../../infra/supabase/migrations');
  const migration = fs.readdirSync(migrationRoot)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => fs.readFileSync(path.join(migrationRoot, file), 'utf8'))
    .join('\n');
  assert.match(migration, /create schema if not exists techunter/i);
  assert.match(migration, /function techunter\.claim_task/i);
  assert.match(migration, /function techunter\.publish_task/i);
  assert.match(migration, /function techunter\.accept_task/i);
  assert.match(migration, /revoke all on schema techunter from public, anon, authenticated/i);
  assert.match(migration, /source_branch text/i);
  assert.match(migration, /set source_branch = default_branch/i);
  assert.doesNotMatch(migration, /local_repo_path|package_path/i);
});

test('authentication lifecycle migration separates sessions, model tickets, and GitHub connections', () => {
  const migration = fs.readFileSync(path.resolve(process.cwd(), '../../infra/supabase/migrations/202608290001_auth_lifecycle.sql'), 'utf8');
  assert.match(migration, /create table techunter\.github_connections/i);
  assert.match(migration, /add column idle_expires_at/i);
  assert.match(migration, /add column model_credential_expires_at/i);
  assert.match(migration, /created_at \+ interval '30 days'/i);
  assert.match(migration, /now\(\) \+ interval '7 days'/i);
  assert.match(migration, /alter table techunter\.sessions drop column github_credential/i);
  assert.match(migration, /alter table techunter\.github_connections enable row level security/i);
});
