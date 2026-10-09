import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { TaskService } from './task-service.js';
import type { AgentService } from './agent-service.js';
import type { GitHubService } from './github-service.js';
import type { TechunterDatabase } from './database.js';

function fixture(count: number, missingImporter = false) {
  const queries: URL[] = [];
  const projects = Array.from({ length: count }, (_, index) => ({
    id: `project-${String(index).padStart(3, '0')}`, name: `Project ${String(count - index).padStart(3, '0')}`,
    imported_by: 'importer', github_repository_id: index, default_branch: 'main', visibility: 'public',
  }));
  const accounts = projects.flatMap((project, index) => [
    { id: `account-${String(index).padStart(3, '0')}-a`, owner_type: 'project', owner_id: project.id, bucket: 'available', balance: index + 1 },
    { id: `account-${String(index).padStart(3, '0')}-r`, owner_type: 'project', owner_id: project.id, bucket: 'reserved', balance: 999 },
  ]);
  // A user sharing an owner's id must not replace the project's balance.
  if (projects.length) accounts.push({ id: 'account-z', owner_type: 'user', owner_id: projects[0]!.id, bucket: 'available', balance: 999 });
  const db = createClient('https://database.fixture.invalid', 'fixture-key', {
    auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'techunter' },
    global: { fetch: async (input, init) => {
      const url = new URL(new Request(input, init).url); queries.push(url);
      let rows: Array<Record<string, unknown>>;
      if (url.pathname.endsWith('/projects')) rows = projects;
      else if (url.pathname.endsWith('/point_accounts')) {
        const ids = url.searchParams.get('owner_id')!.slice(4, -1).split(',');
        rows = accounts.filter(account => ids.includes(account.owner_id));
      } else {
        assert.ok(url.pathname.endsWith('/users'));
        rows = missingImporter ? [] : [{ id: 'importer', login: 'fixture', name: 'Importer', role: 'member' }];
      }
      const cursor = url.searchParams.get('id');
      if (cursor?.startsWith('gt.')) rows = rows.filter(row => String(row['id']) > cursor.slice(3));
      const remaining = rows.length;
      rows = rows.slice(0, Number(url.searchParams.get('limit')));
      return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json', 'content-range': `0-${rows.length - 1}/${remaining}` } });
    } },
  }) as unknown as TechunterDatabase;
  return { queries, service: new TaskService({} as GitHubService, {} as AgentService, () => db) };
}

test('100 projects batch related rows, retain paginated balances and human-readable ordering', async () => {
  const value = fixture(100);
  const projects = await value.service.projects();
  assert.equal(projects.length, 100);
  assert.equal(projects[0]!.name, 'Project 001');
  assert.equal(projects.find(project => project.id === 'project-000')!.availablePoints, 1);
  assert.equal(projects.find(project => project.id === 'project-099')!.availablePoints, 100);
  assert.ok(projects.every(project => project.importedBy?.name === 'Importer'));
  assert.equal(value.queries.length, 5); // formerly 1 + 100 balance + 100 importer reads
});

test('project batches continue beyond 100 ids and an empty directory makes no related reads', async () => {
  const value = fixture(205);
  assert.equal((await value.service.projects()).length, 205);
  const empty = fixture(0);
  assert.deepEqual(await empty.service.projects(), []);
  assert.equal(empty.queries.length, 1);
  await assert.rejects(() => fixture(1, true).service.projects(), /用户不存在/);
});
