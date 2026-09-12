import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { ScopeRequestInput, Task, TaskScope, User } from '@techunter/core';
import type { TechunterDatabase } from './database.js';
import { ScopeRequestService } from './scope-request-service.js';

const db = new PGlite();
const scope: TaskScope = {
  revision: 1, editablePaths: ['src/feature.ts'], readonlyPaths: ['README.md'], deniedPaths: ['src/private/**'], visibleTests: [],
  environment: { setupCommands: [], testCommands: [], networkAllowlist: [] },
};
let worker: User, publisher: User, admin: User, other: User, projectId: string;

// Exercise the real services and SQL with a small in-process PostgREST adapter.
const port = {
  from(table: string) {
    assert.equal(table, 'scope_requests');
    const conditions: Array<[string, unknown]> = [];
    let sorted = false;
    const execute = async (single = false) => {
      const where = conditions.map(([column], i) => `${column} = $${i + 1}`).join(' and ');
      const result = await db.query(`select * from techunter.scope_requests where ${where}${sorted ? ' order by created_at desc' : ''}`, conditions.map(([, value]) => value));
      return { data: single ? result.rows[0] ?? null : result.rows, error: null };
    };
    const builder = {
      select() { return builder; },
      eq(column: string, value: unknown) { assert.ok(['task_id', 'id', 'requester_id'].includes(column)); conditions.push([column, value]); return builder; },
      order() { sorted = true; return execute(); },
      maybeSingle() { return execute(true); },
    };
    return builder;
  },
  async rpc(name: string, args: Record<string, unknown>) {
    assert.ok(['create_scope_request', 'decide_scope_request', 'withdraw_scope_request'].includes(name));
    const entries = Object.entries(args);
    try {
      const result = await db.query<{ result: unknown }>(`select techunter.${name}(${entries.map(([key], i) => `${key} => $${i + 1}`).join(', ')}) as result`, entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value));
      return { data: result.rows[0]?.result, error: null };
    } catch (error) { return { data: null, error: { message: (error as Error).message } }; }
  },
} as unknown as TechunterDatabase;

async function getTask(id: string): Promise<Task> {
  const row = (await db.query<Record<string, any>>('select * from techunter.tasks where id = $1', [id])).rows[0]!;
  const users = [worker, publisher, admin, other];
  return { id, projectId, parentTaskId: row['parent_task_id'], status: row['status'], scope: row['scope_json'], baseSha: row['base_sha'], targetBranch: row['target_branch'],
    publisher: users.find((user) => user.id === row['publisher_id'])!, assignee: users.find((user) => user.id === row['assignee_id']) ?? null } as Task;
}
const service = new ScopeRequestService({ getTask }, () => port);
const input = (revision = 1): ScopeRequestInput => ({
  scopeRevision: revision, files: [{ path: 'README.md', reason: '需要更新使用说明' }, { path: 'src/new.ts', reason: '新增共享实现文件' }],
  reason: '当前范围无法完成任务的验收标准', evidence: '现有测试表明需要更新共享实现与说明',
  alternatives: '仅修改入口文件无法解决共享实现缺失', validationPlan: '运行单元测试并验证原有调用行为兼容',
});
const approval = (approvedPaths = ['README.md']) => ({ decision: 'approve' as const, approvedPaths, reason: '已确认该文件是完成验收所必需的' });

before(async () => {
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const root = path.resolve(process.cwd(), '../../infra/supabase/migrations');
  for (const file of fs.readdirSync(root).filter((file) => file.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(root, file), 'utf8'));
  const users = (await db.query<{ id: string; login: string; role: User['role'] }>("insert into techunter.users(login, name, role) values ('worker', 'Worker', 'member'), ('publisher', 'Publisher', 'member'), ('admin', 'Admin', 'admin'), ('other', 'Other', 'maintainer') returning id, login, role")).rows;
  [worker, publisher, admin, other] = users as User[] as [User, User, User, User];
  projectId = (await db.query<{ id: string }>("insert into techunter.projects(github_repository_id, name, repo_owner, repo_name, clone_url, html_url) values (1, 'fixture', 'test', 'fixture', 'https://github.com/test/fixture.git', 'https://github.com/test/fixture') returning id")).rows[0]!.id;
});
after(async () => { await db.close(); });

async function createTask(parentId: string | null = null, taskScope = scope): Promise<string> {
  return (await db.query<{ id: string }>("insert into techunter.tasks(project_id, title, publisher_id, assignee_id, status, scope_json, analysis_json, parent_task_id, base_sha, reward_points) values ($1, 'fixture', $2, $3, 'active', $4, $5, $6, 'frozen-sha', 50) returning id", [projectId, publisher.id, worker.id, JSON.stringify(taskScope), JSON.stringify({ scope: taskScope, summary: 'unchanged' }), parentId])).rows[0]!.id;
}

test('partial approval is atomic, preserves frozen task data, and writes before/after audit records', async () => {
  const id = await createTask();
  const request = await service.create(id, worker, input());
  assert.deepEqual((await getTask(id)).scope, scope);
  const decided = await service.decide(id, request.id, publisher, approval());
  assert.equal(decided.status, 'partially_approved');
  assert.equal(decided.resultingRevision, 2);
  const row = (await db.query<Record<string, any>>('select * from techunter.tasks where id = $1', [id])).rows[0]!;
  assert.deepEqual(row['scope_json'].editablePaths, ['src/feature.ts', 'README.md']);
  assert.deepEqual(row['scope_json'].readonlyPaths, []);
  assert.deepEqual(row['analysis_json'].scope, row['scope_json']);
  assert.deepEqual(row['scope_json'].deniedPaths, scope.deniedPaths);
  assert.equal(row['base_sha'], 'frozen-sha');
  assert.equal(row['reward_points'], 50);
  assert.equal(row['lock_version'], 1);
  const audit = (await db.query<Record<string, any>>("select payload_json from techunter.audit_events where entity_id = $1 and action = 'scope.partially_approved'", [request.id])).rows[0]!;
  assert.deepEqual(audit['payload_json'].beforeScope, scope);
  assert.equal(audit['payload_json'].afterScope.revision, 2);
  await assert.rejects(() => service.decide(id, request.id, admin, approval()), /已经处理|已处理/);
});

test('competing requests leave one pending request and competing decisions increment revision once', async () => {
  const id = await createTask();
  const results = await Promise.allSettled([service.create(id, worker, input()), service.create(id, worker, input())]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const request = (await service.list(id, worker))[0]!;
  const decisions = await Promise.allSettled([service.decide(id, request.id, publisher, approval()), service.decide(id, request.id, admin, approval())]);
  assert.equal(decisions.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await getTask(id)).scope?.revision, 2);
});

test('only the assignee requests, only publisher/admin decide, and even admin cannot approve their own request', async () => {
  const id = await createTask();
  await assert.rejects(() => service.create(id, other, input()), /接取者/);
  const request = await service.create(id, worker, input());
  await assert.rejects(() => service.decide(id, request.id, other, approval()), /发布者或管理员/);
  assert.deepEqual(await service.list(id, other), []);
  assert.equal((await service.list(id, publisher)).length, 1);
  await assert.rejects(() => service.decide(id, request.id, { ...worker, role: 'admin' }, approval()), /自己的/);
  const direct = await port.rpc('decide_scope_request', { p_task_id: id, p_request_id: request.id, p_actor_id: worker.id, p_scope: scope, p_parent_scope: null, p_decision: 'approve', p_approved_paths: ['README.md'], p_reason: 'cannot self approve' });
  assert.match(direct.error!.message, /SCOPE_SELF_REVIEW/);
  assert.equal((await getTask(id)).scope?.revision, 1);
});

test('rejection requires new evidence; a withdrawn appeal can be replaced without branching live decisions', async () => {
  const id = await createTask();
  const original = await service.create(id, worker, input());
  await service.decide(id, original.id, publisher, { decision: 'reject', approvedPaths: [], reason: '需要先证明现有接口不能满足需求' });
  assert.deepEqual((await getTask(id)).scope, scope);
  await assert.rejects(() => service.create(id, worker, { ...input(), retryOf: original.id }), /新的证据/);
  const retryInput = { ...input(), retryOf: original.id, evidence: '补充接口调用链与失败用例以回应之前意见' };
  const retry = await service.create(id, worker, retryInput);
  assert.equal(retry.retryOf, original.id);
  await service.withdraw(id, retry.id, worker);
  const replacement = await service.create(id, worker, retryInput);
  assert.equal(replacement.retryOf, original.id);
  await service.decide(id, replacement.id, publisher, { decision: 'reject', approvedPaths: [], reason: '仍需回应接口兼容性的具体问题' });
  await assert.rejects(() => service.create(id, worker, retryInput), /复议来源无效/);
});

test('withdrawal, release, submission, reassignment and scope edits make old requests unusable', async () => {
  const withdrawnId = await createTask();
  const withdrawn = await service.create(withdrawnId, worker, input());
  await assert.rejects(() => service.withdraw(withdrawnId, withdrawn.id, other), /权限/);
  await service.withdraw(withdrawnId, withdrawn.id, worker);
  await assert.rejects(() => service.decide(withdrawnId, withdrawn.id, publisher, approval()));
  for (const update of ["status = 'open', assignee_id = null", "status = 'submitted'", `assignee_id = '${other.id}'`, "scope_json = jsonb_set(scope_json, '{revision}', '2')"]) {
    const id = await createTask();
    const request = await service.create(id, worker, input());
    await db.query(`update techunter.tasks set ${update} where id = $1`, [id]);
    assert.equal((await service.list(id, worker))[0]?.status, 'superseded');
    await assert.rejects(() => service.decide(id, request.id, publisher, approval()));
  }
});

test('children cannot acquire parent readonly files; parent changes invalidate the API validation snapshot', async () => {
  const parentId = await createTask();
  await db.query('update techunter.tasks set assignee_id=$1 where id=$2', [publisher.id, parentId]);
  const childId = await createTask(parentId);
  await assert.rejects(() => service.create(childId, worker, input()), /父任务/);
  const expandedParent = { ...scope, revision: 2, editablePaths: [...scope.editablePaths, 'README.md', 'src/new.ts'] };
  await db.query('update techunter.tasks set scope_json = $1 where id = $2', [JSON.stringify(expandedParent), parentId]);
  const request = await service.create(childId, worker, input());
  const stale = await port.rpc('decide_scope_request', { p_task_id: childId, p_request_id: request.id, p_actor_id: publisher.id, p_scope: scope, p_parent_scope: scope, p_decision: 'approve', p_approved_paths: ['README.md'], p_reason: 'parent snapshot is stale' });
  assert.match(stale.error!.message, /SCOPE_REVISION_CONFLICT/);
  await service.decide(childId, request.id, publisher, approval());
  assert.equal((await getTask(childId)).scope?.revision, 2);
});

test('SQL grants are an exact subset of the request and untrusted roles cannot call privileged functions', async () => {
  const id = await createTask();
  const request = await service.create(id, worker, input());
  const result = await port.rpc('decide_scope_request', { p_task_id: id, p_request_id: request.id, p_actor_id: publisher.id, p_scope: scope, p_parent_scope: null, p_decision: 'approve', p_approved_paths: ['src/unrequested.ts'], p_reason: 'must not grant this file' });
  assert.match(result.error!.message, /SCOPE_DECISION_INVALID/);
  for (const role of ['anon', 'authenticated']) {
    const permissions = await db.query<{ allowed: boolean }>("select has_function_privilege($1, 'techunter.withdraw_scope_request(uuid,uuid,uuid)', 'execute') as allowed", [role]);
    assert.equal(permissions.rows[0]?.allowed, false);
  }
});
