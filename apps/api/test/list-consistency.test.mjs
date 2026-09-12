// Regression tests: real Supabase SDK against an isolated HTTP substitute.
// The real TaskService and Supabase SDK use an in-memory HTTP substitute.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { TaskService } from '../dist/task-service.js';

function fixture({ count, cap = 1000, distinctPublishers = false, moveAfterFirstPage = false }) {
  const tasks = Array.from({ length: count }, (_, i) => ({ id: String(i), project_id: 'project',
    publisher_id: distinctPublishers ? `publisher-${i}` : 'publisher', assignee_id: null,
    title: `Task ${i}`, status: i === count - 1 ? 'active' : 'accepted',
    updated_at: new Date(Date.UTC(2026, 0, 1) - i * 1000).toISOString() }));
  const users = distinctPublishers ? tasks.map(t => ({ id: t.publisher_id, name: t.publisher_id })) : [{ id: 'publisher', name: 'Publisher' }];
  const requests = [];
  let moved = false;
  const db = createClient('https://database.fixture.invalid', 'fixture-service-key-never-real', {
    auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'techunter' },
    global: { fetch: async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      assert.equal(url.hostname, 'database.fixture.invalid');
      const table = url.pathname.split('/').at(-1);
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Math.min(cap, Number(url.searchParams.get('limit') || 1000));
      requests.push({ table, offset, limit });
      let data;
      if (table === 'tasks') data = tasks;
      else if (table === 'projects') data = [{ id: 'project', name: 'Project' }];
      else if (table === 'users') {
        const ids = (url.searchParams.get('id') || '').replace(/^in\.\(/, '').replace(/\)$/, '').split(',');
        data = users.filter(u => ids.includes(u.id));
      } else if (table === 'scope_requests') data = [];
      else throw new Error(`Unexpected table: ${table}`);
      const cursor = url.searchParams.getAll('id').find(value => value.startsWith('gt.'))?.slice(3) || '';
      data = data.filter(row => row.id > cursor).sort((a, b) => a.id < b.id ? -1 : 1);
      const page = data.slice(offset, offset + limit);
      const body = JSON.stringify(page);
      if (table === 'tasks' && !moved && moveAfterFirstPage) {
        moved = true;
        // A task update between two SELECT requests moves a not-yet-read row to the front.
        const updated = tasks.pop();
        updated.updated_at = new Date(Date.UTC(2026, 0, 2)).toISOString();
        tasks.unshift(updated);
      }
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json',
        'content-range': `${offset}-${offset + page.length - 1}/${data.length}` } });
    } },
  });
  return { service: new TaskService({}, {}, () => db.schema('techunter')), requests };
}

test('an update between pages keeps all task IDs exactly once and includes the active task', async () => {
  const stable = await fixture({ count: 501 }).service.listTasks();
  assert.equal(new Set(stable.map(t => t.id)).size, 501);
  assert.equal(stable.some(t => t.id === '500'), true);
  const f = fixture({ count: 501, moveAfterFirstPage: true });
  const result = await f.service.listTasks();
  assert.equal(result.length, 501);
  assert.equal(new Set(result.map(t => t.id)).size, 501);
  assert.equal(result.some(t => t.id === '500'), true);
  assert.equal(result.filter(t => t.id === '499').length, 1);
});

test('a server row cap below 100 paginates associated users without failing the task list', async () => {
  assert.equal((await fixture({ count: 100, distinctPublishers: true }).service.listTasks()).length, 100);
  const f = fixture({ count: 100, cap: 73, distinctPublishers: true });
  const tasks = await f.service.listTasks();
  assert.equal(tasks.length, 100);
  assert.equal(new Set(tasks.map(t => t.publisher.id)).size, 100);
  assert.equal(f.requests.filter(r => r.table === 'tasks').length, 2);
  assert.equal(f.requests.filter(r => r.table === 'users').length, 2);
});
