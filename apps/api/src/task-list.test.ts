import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentService } from './agent-service.js';
import type { GitHubService } from './github-service.js';
import type { TechunterDatabase } from './database.js';
import { TaskService } from './task-service.js';

test('task lists batch shared project and user lookups instead of querying for every task', async () => {
  const tables: string[] = [];
  const rows: Record<string, unknown[]> = {
    tasks: Array.from({ length: 120 }, (_, id) => ({ id: String(id), project_id: 'project', publisher_id: 'publisher', assignee_id: 'worker', title: 'fixture', status: 'active', updated_at: '2026-09-12' })),
    projects: [{ id: 'project', name: 'Fixture' }], users: [{ id: 'publisher', name: 'Publisher' }, { id: 'worker', name: 'Worker' }], scope_requests: [{ task_id: '0' }],
  };
  const db = { from(table: string) {
    tables.push(table);
    const builder = {
      select() { return builder; }, order() { return builder; }, neq() { return builder; }, eq() { return builder; }, in() { return builder; },
      then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: rows[table], error: null }).then(resolve); },
    }; return builder;
  } } as unknown as TechunterDatabase;
  const tasks = await new TaskService({} as GitHubService, {} as AgentService, () => db).listTasks();
  assert.equal(tasks.length, 120); assert.equal(tasks[0]!.projectName, 'Fixture');
  assert.equal(tasks.find(t => t.id === '0')!.pendingScopeRequestCount, 1);
  assert.deepEqual(tables, ['tasks', 'projects', 'users', 'scope_requests']);
});
