import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentService } from './agent-service.js';
import type { GitHubService } from './github-service.js';
import type { TechunterDatabase } from './database.js';
import { TaskService } from './task-service.js';
import { createClient } from '@supabase/supabase-js';
import { readRowsById } from './database-pagination.js';

test('task lists batch shared project and user lookups instead of querying for every task', async () => {
  const tables: string[] = [];
  const rows: Record<string, unknown[]> = {
    tasks: Array.from({ length: 120 }, (_, id) => ({ id: String(id), project_id: 'project', publisher_id: 'publisher', assignee_id: 'worker', title: 'fixture', status: 'active', updated_at: '2026-09-12' })),
    projects: [{ id: 'project', name: 'Fixture' }], users: [{ id: 'publisher', name: 'Publisher' }, { id: 'worker', name: 'Worker' }], scope_requests: [{ id: 'request', task_id: '0' }],
  };
  const db = { from(table: string) {
    tables.push(table);
    let after = '', limit = Number.POSITIVE_INFINITY;
    const builder = {
      select() { return builder; }, order() { return builder; }, neq() { return builder; }, eq() { return builder; }, in() { return builder; },
      gt(_key: string, value: string) { after = value; return builder; }, limit(value: number) { limit = value; return builder; },
      then(resolve: (value: unknown) => unknown) {
        const data = (rows[table]! as { id: string }[]).filter(row => row.id > after).sort((a, b) => a.id < b.id ? -1 : 1);
        return Promise.resolve({ data: data.slice(0, limit), count: data.length, error: null }).then(resolve);
      },
    }; return builder;
  } } as unknown as TechunterDatabase;
  const tasks = await new TaskService({} as GitHubService, {} as AgentService, () => db).listTasks();
  assert.equal(tasks.length, 120); assert.equal(tasks[0]!.projectName, 'Fixture');
  assert.equal(tasks.find(t => t.id === '0')!.pendingScopeRequestCount, 1);
  assert.deepEqual(tables, ['tasks', 'projects', 'users', 'scope_requests']);
});

test('complete task lists survive default and reduced PostgREST caps and retain old active tasks and pending scope requests', async () => {
  for (const cap of [1000, 73]) {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ id: String(i), project_id: 'project', publisher_id: 'publisher',
      assignee_id: 'worker', title: `Task ${i}`, status: i === 1000 ? 'active' : 'accepted', updated_at: new Date(Date.UTC(2026, 0, 1) - i * 1000).toISOString() }));
    const cursors: string[] = [];
    const db = createClient('https://database.fixture.invalid', 'fixture-service-key-never-real', {
      auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'techunter' },
      global: { fetch: async (input, init) => {
        const request = new Request(input, init), url = new URL(request.url), table = url.pathname.split('/').at(-1);
        assert.equal(url.hostname, 'database.fixture.invalid');
        let data: { id: string; [key: string]: unknown }[];
        if (table === 'tasks') {
          assert.equal(url.searchParams.get('order'), 'id.asc');
          cursors.push(url.searchParams.get('id') || ''); data = rows;
        } else if (table === 'scope_requests') data = rows.map(row => ({ id: row.id, task_id: row.id }));
        else if (table === 'projects') data = [{ id: 'project', name: 'Fixture' }];
        else if (table === 'users') data = [{ id: 'publisher', name: 'Publisher' }, { id: 'worker', name: 'Worker' }];
        else throw new Error(`Unexpected table: ${table}`);
        const cursor = url.searchParams.getAll('id').find(value => value.startsWith('gt.'))?.slice(3) || '';
        data = data.filter(row => row.id > cursor).sort((a, b) => a.id < b.id ? -1 : 1);
        const length = Math.min(cap, Number(url.searchParams.get('limit') || 1000)), page = data.slice(0, length);
        return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json', 'content-range': `0-${page.length - 1}/${data.length}` } });
      } },
    }) as unknown as TechunterDatabase;
    const tasks = await new TaskService({} as GitHubService, {} as AgentService, () => db).listTasks();
    assert.equal(tasks.length, 1001); assert.equal(new Set(tasks.map(task => task.id)).size, 1001);
    assert.equal(tasks[0]!.id, '1000'); assert.equal(tasks[0]!.status, 'active'); assert.equal(tasks[0]!.pendingScopeRequestCount, 1);
    assert.ok(cursors.length > 1); assert.ok(cursors[1]?.startsWith('gt.'));
  }
});

test('a page without count continues after short capped responses and propagates later database failures', async () => {
  const all = ['1', '2', '3', '4', '5'].map(id => ({ id }));
  assert.deepEqual(await readRowsById(async after => ({ data: all.filter(row => row.id > (after || '')).slice(0, 2), error: null })), all);
  await assert.rejects(() => readRowsById(async after => after
    ? { data: null, error: { message: 'database unavailable' } } : { data: [{ id: '1' }], count: 2, error: null }), /database unavailable/);
  await assert.rejects(() => readRowsById(async () => ({ data: [{ id: '1' }], error: null })), /游标未前进/);
});
