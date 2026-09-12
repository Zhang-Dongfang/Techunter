import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentService } from './agent-service.js';
import type { GitHubService } from './github-service.js';
import type { TechunterDatabase } from './database.js';
import { TaskService } from './task-service.js';
import { createClient } from '@supabase/supabase-js';
import { readAllRows } from './database-pagination.js';

test('task lists batch shared project and user lookups instead of querying for every task', async () => {
  const tables: string[] = [];
  const rows: Record<string, unknown[]> = {
    tasks: Array.from({ length: 120 }, (_, id) => ({ id: String(id), project_id: 'project', publisher_id: 'publisher', assignee_id: 'worker', title: 'fixture', status: 'active', updated_at: '2026-09-12' })),
    projects: [{ id: 'project', name: 'Fixture' }], users: [{ id: 'publisher', name: 'Publisher' }, { id: 'worker', name: 'Worker' }], scope_requests: [{ task_id: '0' }],
  };
  const db = { from(table: string) {
    tables.push(table);
    let from = 0, to = Number.POSITIVE_INFINITY;
    const builder = {
      select() { return builder; }, order() { return builder; }, neq() { return builder; }, eq() { return builder; }, in() { return builder; },
      range(start: number, end: number) { from = start; to = end; return builder; },
      then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: rows[table]!.slice(from, to + 1), count: rows[table]!.length, error: null }).then(resolve); },
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
    const offsets: number[] = [];
    const db = createClient('https://database.fixture.invalid', 'fixture-service-key-never-real', {
      auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'techunter' },
      global: { fetch: async (input, init) => {
        const request = new Request(input, init), url = new URL(request.url), table = url.pathname.split('/').at(-1);
        assert.equal(url.hostname, 'database.fixture.invalid');
        let data: unknown[];
        if (table === 'tasks') {
          assert.equal(url.searchParams.get('order'), 'updated_at.desc,id.desc');
          offsets.push(Number(url.searchParams.get('offset'))); data = rows;
        } else if (table === 'scope_requests') data = rows.map(row => ({ task_id: row.id }));
        else if (table === 'projects') data = [{ id: 'project', name: 'Fixture' }];
        else if (table === 'users') data = [{ id: 'publisher', name: 'Publisher' }, { id: 'worker', name: 'Worker' }];
        else throw new Error(`Unexpected table: ${table}`);
        const from = Number(url.searchParams.get('offset') || 0), length = Math.min(cap, Number(url.searchParams.get('limit') || 1000));
        const page = data.slice(from, from + length);
        return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json', 'content-range': `${from}-${from + page.length - 1}/${data.length}` } });
      } },
    }) as unknown as TechunterDatabase;
    const tasks = await new TaskService({} as GitHubService, {} as AgentService, () => db).listTasks();
    assert.equal(tasks.length, 1001); assert.equal(new Set(tasks.map(task => task.id)).size, 1001);
    assert.equal(tasks[0]!.id, '1000'); assert.equal(tasks[0]!.status, 'active'); assert.equal(tasks[0]!.pendingScopeRequestCount, 1);
    assert.ok(offsets.length > 1); assert.equal(offsets[1], Math.min(cap, 500));
  }
});

test('a page without count continues after short capped responses and propagates later database failures', async () => {
  const all = [1, 2, 3, 4, 5];
  assert.deepEqual(await readAllRows<number>(async from => ({ data: all.slice(from, from + 2), error: null })), all);
  await assert.rejects(() => readAllRows<number>(async from => from
    ? { data: null, error: { message: 'database unavailable' } } : { data: [1], count: 2, error: null }), /database unavailable/);
});
