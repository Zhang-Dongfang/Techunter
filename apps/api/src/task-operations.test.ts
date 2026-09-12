import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Task, Project, User } from '@techunter/core';
import type { AgentService } from './agent-service.js';
import type { TechunterDatabase } from './database.js';
import type { GitHubService } from './github-service.js';
import { TaskService } from './task-service.js';

const db = new PGlite();
let publisher: string, worker: string, serial = 0;
const scope = { revision: 1, editablePaths: ['src/a.ts'], readonlyPaths: [], deniedPaths: [], visibleTests: [], environment: { setupCommands: [], testCommands: [], networkAllowlist: [] } };
const analysis = { summary: 'new analysis', acceptanceCriteria: ['works'], scope, suggestedPoints: 30, confidence: 'high' };
before(async () => {
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const root = path.resolve('../../infra/supabase/migrations');
  for (const name of fs.readdirSync(root).filter(n => n.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(root, name), 'utf8'));
  const users = (await db.query<{ id: string }>("insert into techunter.users(login,name,role,github_login) values('publisher','Publisher','admin','publisher'),('worker','Worker','member','worker') returning id")).rows;
  publisher = users[0]!.id; worker = users[1]!.id;
});
after(async () => { await db.close(); });

async function fixture() {
  const project = (await db.query<{ id: string }>("insert into techunter.projects(github_repository_id,name,repo_owner,repo_name,clone_url,html_url) values($1,'fixture','test',$2,'https://example.invalid/repo.git','https://example.invalid/repo') returning id", [++serial, `fixture-${serial}`])).rows[0]!.id;
  await db.query('select techunter.allocate_project_points($1,100)', [project]);
  const draft = async () => (await db.query<{ id: string }>('insert into techunter.tasks(project_id,title,publisher_id,scope_json,base_sha) values($1,$2,$3,$4,$5) returning id', [project, 'fixture', publisher, JSON.stringify(scope), 'frozen-sha'])).rows[0]!.id;
  return { project, draft, id: await draft() };
}
const begin = (id: string, reward = 60, actor = publisher) => db.query('select techunter.begin_task_publication($1,$2,$3,0)', [id, actor, reward]);
const lease = (id: string, token: string, actor = publisher) => db.query<Record<string, unknown>>('select techunter.lease_task_operation($1,$2,$3)', [id, actor, token]);
const finish = (id: string, token: string) => db.query('select techunter.finish_task_publication($1,$2,1,$3)', [id, token, 'https://example.invalid/issues/1']);

test('late analyses cannot change publication holds, published rewards, or a newer analysis', async () => {
  const f = await fixture();
  await begin(f.id, 10);
  await assert.rejects(() => db.query('select techunter.save_task_analysis($1,$2,0,null,$3)', [f.id, publisher, JSON.stringify(analysis)]), /TASK_VERSION_CONFLICT/);
  const token = randomUUID(); await lease(f.id, token); await finish(f.id, token);
  await assert.rejects(() => db.query('select techunter.save_task_analysis($1,$2,0,null,$3)', [f.id, publisher, JSON.stringify(analysis)]), /TASK_VERSION_CONFLICT/);
  await assert.rejects(() => db.query('update techunter.tasks set reward_points=30 where id=$1', [f.id]), /TASK_VERSION_CONFLICT/);
  const row = (await db.query<{ reward_points: number }>('select reward_points from techunter.tasks where id=$1', [f.id])).rows[0]!;
  assert.equal(Number(row.reward_points), 10);
  const draft = await f.draft();
  await db.query('select techunter.save_task_analysis($1,$2,0,null,$3)', [draft, publisher, JSON.stringify(analysis)]);
  await assert.rejects(() => db.query('select techunter.save_task_analysis($1,$2,0,null,$3)', [draft, publisher, JSON.stringify(analysis)]), /TASK_VERSION_CONFLICT/);
});

test('publication checks permissions and holds concurrent budgets before GitHub work', async () => {
  const f = await fixture();
  await assert.rejects(() => begin(f.id, 60, worker), /FORBIDDEN/);
  const second = await f.draft();
  const attempts = await Promise.allSettled([begin(f.id), begin(second)]);
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
  assert.equal((await db.query('select id from techunter.task_operations where task_id in ($1,$2)', [f.id, second])).rows.length, 1);
  assert.equal(Number((await db.query<{ balance: number }>("select balance from techunter.point_accounts where owner_type='project' and owner_id=$1 and bucket='reserved'", [f.project])).rows[0]!.balance), 0);
});

test('expired operations resume with a new lease and reject writes from the old process', async () => {
  const f = await fixture(); await begin(f.id);
  const old = randomUUID(), next = randomUUID(); await lease(f.id, old);
  await assert.rejects(() => lease(f.id, next), /OPERATION_IN_PROGRESS/);
  await db.query("update techunter.task_operations set lease_until=now()-interval '1 second' where id=$1", [f.id]);
  await lease(f.id, next);
  await assert.rejects(() => finish(f.id, old), /OPERATION_LEASE_LOST/);
  await finish(f.id, next);
  await finish(f.id, next);
  assert.equal((await db.query("select id from techunter.point_transfers where task_id=$1 and type='task_reserve'", [f.id])).rows.length, 1);
});

test('withdrawing an unfinished publication releases its hold and permits draft analysis again', async () => {
  const f = await fixture(); await begin(f.id, 80);
  const other = await f.draft(); await assert.rejects(() => begin(other, 30), /INSUFFICIENT_POINTS/);
  const token = randomUUID(); await lease(f.id, token);
  await db.query('select techunter.cancel_task_publication($1,$2)', [f.id, token]);
  await begin(other, 30);
  await db.query('select techunter.save_task_analysis($1,$2,0,null,$3)', [f.id, publisher, JSON.stringify(analysis)]);
  await assert.rejects(() => finish(f.id, token), /OPERATION_LEASE_LOST|INVALID_REWARD/);
});

test('submission survives a process interruption and restores stale packages safely', async () => {
  const f = await fixture();
  await db.query('select techunter.publish_task($1,$2,10,1,$3)', [f.id, publisher, 'https://example.invalid/issues/1']);
  await db.query('select techunter.claim_task($1,$2)', [f.id, worker]);
  await db.query("insert into techunter.workspaces(task_id,user_id,status,device_id) values($1,$2,'running','fixture')", [f.id, worker]);
  const review = { verdict: 'approved' }, files = [{ path: 'src/a.ts', content: 'saved package', encoding: 'utf-8' }];
  const sub = (await db.query<{ id: string }>('select techunter.begin_submission_operation($1,$2,$3,$4,$5,$6,$7,$8) as id', [f.id, worker, JSON.stringify(scope), 'summary', 'tests', JSON.stringify(files), JSON.stringify(review), 'remote-head'])).rows[0]!.id;
  await db.query('select techunter.prepare_submission_recovery($1,$2)', [sub, worker]);
  const token = randomUUID();
  const result = (await lease(sub, token, worker)).rows[0]!['lease_task_operation'] as { files: unknown; headSha: string };
  assert.deepEqual(result.files, files); assert.equal(result.headSha, 'remote-head');
  await assert.rejects(() => db.query('select techunter.admin_remove_task($1,$2)', [f.id, publisher]), /OPERATION_IN_PROGRESS/);
  await db.query('select techunter.finish_submission_operation($1,$2,null,false)', [sub, token]);
  assert.equal((await db.query<{ status: string }>('select status from techunter.tasks where id=$1', [f.id])).rows[0]!.status, 'active');
});

test('analysis receives the frozen task SHA and saves with the original task version', async () => {
  let analyzedSha: string | undefined, written: Record<string, unknown> | undefined;
  const agent = { async analyze(input: { project: Project }) { analyzedSha = input.project.headSha; return analysis; } } as unknown as AgentService;
  const port = { async rpc(_name: string, args: Record<string, unknown>) { written = args; return { error: null }; } } as unknown as TechunterDatabase;
  const service = new TaskService({} as GitHubService, agent, () => port);
  service.getTask = async () => ({ id: 'task', projectId: 'project', status: 'draft', version: 7, baseSha: 'frozen-child-head', publisher: { id: 'actor' } } as Task);
  service.getProject = async () => ({ headSha: 'new-project-head' } as Project);
  await service.analyzeTask('task', { id: 'actor', role: 'member' } as User);
  assert.equal(analyzedSha, 'frozen-child-head'); assert.equal(written?.['p_version'], 7);
});

test('unrelated users cannot create GitHub issues through the publish service', async () => {
  let created = 0;
  const service = new TaskService({ async createIssue() { created++; } } as unknown as GitHubService, {} as AgentService);
  service.getTask = async () => ({ status: 'draft', publisher: { id: 'owner' } } as Task);
  await assert.rejects(() => service.publishTask('task', { id: 'other', role: 'member' } as User, 10), /权限/);
  assert.equal(created, 0);
});

test('browser database roles cannot read operation packages or invoke recovery functions', async () => {
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query<{ allowed: boolean }>('select has_table_privilege($1,$2,$3) as allowed', [role, 'techunter.task_operations', 'SELECT'])).rows[0]!.allowed, false);
    for (const signature of ['begin_task_publication(uuid,uuid,bigint,integer)', 'save_task_analysis(uuid,uuid,integer,jsonb,jsonb)', 'lease_task_operation(uuid,uuid,uuid)', 'finish_submission_operation(uuid,uuid,text,boolean)', 'publish_task_unchecked(uuid,uuid,bigint,bigint,text)']) {
      assert.equal((await db.query<{ allowed: boolean }>('select has_function_privilege($1,$2,$3) as allowed', [role, `techunter.${signature}`, 'EXECUTE'])).rows[0]!.allowed, false);
    }
  }
});
