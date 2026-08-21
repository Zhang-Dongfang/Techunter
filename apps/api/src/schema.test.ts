import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('Supabase migration owns the shared schema and atomic invariants', () => {
  const migration = fs.readFileSync(path.resolve(process.cwd(), '../../infra/supabase/migrations/202608210001_techunter_schema.sql'), 'utf8');
  assert.match(migration, /create schema if not exists techunter/i);
  assert.match(migration, /function techunter\.claim_task/i);
  assert.match(migration, /function techunter\.publish_task/i);
  assert.match(migration, /function techunter\.accept_task/i);
  assert.match(migration, /revoke all on schema techunter from public, anon, authenticated/i);
  assert.doesNotMatch(migration, /local_repo_path|package_path/i);
});
