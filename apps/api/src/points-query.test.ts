import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { TaskService } from './task-service.js';
import type { AgentService } from './agent-service.js';
import type { GitHubService } from './github-service.js';
import type { TechunterDatabase } from './database.js';

function fixture(options: { missing?: boolean; fail?: boolean; noTransfers?: boolean; direction?: 'expense' | 'internal' } = {}) {
  const queries: URL[] = [];
  const accounts = [{ id: 'project-account', label: 'Project' }, { id: 'user-account', label: 'User' }];
  const db = createClient('https://database.fixture.invalid', 'fixture-service-key-never-real', {
    auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'techunter' },
    global: { fetch: async (input, init) => {
      const url = new URL(new Request(input, init).url);
      assert.equal(url.hostname, 'database.fixture.invalid');
      queries.push(url);
      let data: unknown;
      if (url.searchParams.get('select') === 'balance') data = { balance: url.searchParams.get('bucket') === 'eq.available' ? 50 : 0 };
      else if (url.searchParams.get('select') === 'id') data = options.direction === 'internal' ? [{ id: 'user-account' }, { id: 'project-account' }] : [{ id: 'user-account' }];
      else if (url.pathname.endsWith('/point_transfers')) data = options.noTransfers ? [] : Array.from({ length: 100 }, (_, id) => ({
        id: String(id), from_account_id: options.direction === 'expense' ? 'user-account' : 'project-account', to_account_id: options.direction === 'expense' ? 'project-account' : 'user-account', type: 'task_settlement', amount: 1,
        memo: 'fixture', task_id: 'task', created_at: '2026-10-08',
      }));
      else {
        assert.equal(url.searchParams.get('select'), 'id,label');
        if (options.fail) return new Response(JSON.stringify({ message: 'database unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
        data = options.missing ? accounts.slice(1) : accounts;
      }
      const count = Array.isArray(data) ? data.length : 1;
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json', 'content-range': `0-${count - 1}/${count}` } });
    } },
  }) as unknown as TechunterDatabase;
  return { service: new TaskService({} as GitHubService, {} as AgentService, () => db), queries };
}

test('100 ledger entries share one batch of account labels instead of 200 per-entry reads', async () => {
  const value = fixture();
  const result = await value.service.points('user');
  assert.equal(result.available, 50);
  assert.equal(result.entries.length, 100);
  assert.ok(result.entries.every(entry => entry.fromLabel === 'Project' && entry.toLabel === 'User'));
  assert.ok(result.entries.every(entry => entry.direction === 'income'));
  assert.equal(value.queries.length, 5);
  assert.equal(value.queries.filter(url => url.searchParams.get('select') === 'id,label').length, 1);
});

test('ledger distinguishes expenses and internal bucket transfers from income', async () => {
  assert.ok((await fixture({ direction: 'expense' }).service.points('user')).entries.every(entry => entry.direction === 'expense'));
  assert.ok((await fixture({ direction: 'internal' }).service.points('user')).entries.every(entry => entry.direction === 'internal'));
});

test('empty ledger avoids label queries and missing or unavailable accounts fail explicitly', async () => {
  const empty = fixture({ noTransfers: true });
  assert.deepEqual((await empty.service.points('user')).entries, []);
  assert.equal(empty.queries.length, 4);
  await assert.rejects(() => fixture({ missing: true }).service.points('user'), /账户不存在/);
  await assert.rejects(() => fixture({ fail: true }).service.points('user'), /database unavailable/);
});
