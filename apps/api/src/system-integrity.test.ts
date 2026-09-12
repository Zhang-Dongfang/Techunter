import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

type Row = Record<string, any>;
const db = new PGlite();
const scope = { revision: 1, editablePaths: ['src/a.ts'], readonlyPaths: [], deniedPaths: [], visibleTests: [], environment: { setupCommands: [], testCommands: [], networkAllowlist: [] } };
let admin: string, worker: string, other: string, serial = 0;
before(async () => {
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const root = path.resolve('../../infra/supabase/migrations');
  for (const name of fs.readdirSync(root).filter(n => n.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(root, name), 'utf8'));
  const rows = (await db.query<Row>("insert into techunter.users(login,name,role,github_login) values('admin','Admin','admin','admin'),('worker','Worker','member','worker'),('other','Other','member','other') returning id")).rows;
  [admin, worker, other] = rows.map(row => row['id']);
});
after(async () => { await db.close(); });

async function rpc(name: string, args: unknown[]) {
  assert.match(name, /^[a-z_]+$/);
  return (await db.query<Row>(`select techunter.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as result`,
    args.map(value => value && typeof value === 'object' ? JSON.stringify(value) : value))).rows[0]!['result'];
}
async function fixture() {
  const project = (await db.query<Row>("insert into techunter.projects(github_repository_id,name,repo_owner,repo_name,clone_url,html_url) values($1,'fixture','test',$2,'https://example.invalid/repo.git','https://example.invalid/repo') returning id", [++serial, `fixture-${serial}`])).rows[0]!['id'];
  await rpc('allocate_project_points', [project, 100]);
  const draft = async (publisher = admin, parent: string | null = null) => (await db.query<Row>(
    "insert into techunter.tasks(project_id,title,publisher_id,parent_task_id,scope_json,base_sha) values($1,'fixture',$2,$3,$4,'base') returning id",
    [project, publisher, parent, JSON.stringify(scope)])).rows[0]!['id'] as string;
  const id = await draft();
  await rpc('publish_task', [id, admin, 100, serial, 'https://example.invalid/issues/1']);
  await rpc('claim_task', [id, worker]);
  return { project, id, draft };
}

test('child drafts and publications enforce the current parent assignee before holding budget', async () => {
  const f = await fixture();
  await assert.rejects(() => f.draft(other, f.id), /FORBIDDEN/);
  const child = await f.draft(worker, f.id);
  assert.equal((await db.query<Row>('select root_task_id from techunter.tasks where id=$1', [child])).rows[0]!['root_task_id'], f.id);
  await db.query('update techunter.tasks set assignee_id=$1 where id=$2', [other, f.id]);
  await assert.rejects(() => rpc('begin_task_publication', [child, worker, 80, 0]), /FORBIDDEN/);
  assert.equal((await db.query('select id from techunter.task_operations where task_id=$1', [child])).rows.length, 0);
  const adminChild = await f.draft(admin, f.id);
  await rpc('publish_task', [adminChild, admin, 20, 2, 'https://example.invalid/issues/2']);
  await db.query("update techunter.tasks set status='submitted' where id=$1", [f.id]);
  await assert.rejects(() => f.draft(admin, f.id), /TASK_NOT_SUBMITTABLE/);
});

test('release holds reject late child drafts, publication, and workspace updates', async () => {
  const f = await fixture();
  const workspace = await rpc('create_task_workspace', [f.id, worker, 'device', 'fixture']);
  const operation = await rpc('begin_task_release', [f.id, worker]);
  assert.equal(await rpc('begin_task_release', [f.id, worker]), operation);
  await assert.rejects(() => f.draft(worker, f.id), /TASK_NOT_SUBMITTABLE/);
  await assert.rejects(() => rpc('create_task_workspace', [f.id, worker, 'device', 'fixture']), /OPERATION_IN_PROGRESS/);
  await assert.rejects(() => rpc('update_task_workspace', [workspace, worker, { status: 'running' }]), /OPERATION_IN_PROGRESS/);
  await assert.rejects(() => rpc('finish_task_release', [operation, randomUUID()]), /OPERATION_LEASE_LOST/);
  const token = randomUUID();
  await rpc('lease_task_operation', [operation, worker, token]);
  await rpc('finish_task_release', [operation, token]);
  await rpc('finish_task_release', [operation, token]);
  assert.equal((await db.query<Row>('select status from techunter.tasks where id=$1', [f.id])).rows[0]!['status'], 'open');
});

test('same-device account changes and reclaims create fresh workspaces and never revive stopped records', async () => {
  const f = await fixture();
  const workspace = await rpc('create_task_workspace', [f.id, worker, 'shared-device', 'fixture']);
  assert.equal(await rpc('create_task_workspace', [f.id, worker, 'shared-device', 'fixture']), workspace);
  assert.equal((await rpc('update_task_workspace', [workspace, worker, { status: 'running', headSha: 'base' }]))['status'], 'running');
  await assert.rejects(() => rpc('create_task_workspace', [f.id, other, 'shared-device', 'fixture']), /FORBIDDEN/);
  await rpc('release_task', [f.id, worker]);
  await rpc('claim_task', [f.id, other]);
  const next = await rpc('create_task_workspace', [f.id, other, 'shared-device', 'fixture']);
  assert.notEqual(next, workspace);
  await assert.rejects(() => rpc('update_task_workspace', [workspace, worker, { status: 'running' }]), /WORKSPACE_NOT_READY/);
  await assert.rejects(() => rpc('update_task_workspace', [next, worker, { status: 'running' }]), /FORBIDDEN/);
  await rpc('release_task', [f.id, other]);
  await rpc('claim_task', [f.id, worker]);
  assert.notEqual(await rpc('create_task_workspace', [f.id, worker, 'shared-device', 'fixture']), workspace);
  await assert.rejects(() => rpc('update_task_workspace', [workspace, worker, { status: 'running' }]), /WORKSPACE_NOT_READY/);
});

test('concurrent project imports initialize once and reimport preserves branch, importer, and allocation', async () => {
  const repository = { githubRepositoryId: ++serial, name: `import-${serial}`, owner: 'test', description: '', defaultBranch: 'main', visibility: 'private', headSha: 'base', cloneUrl: 'https://example.invalid/repo.git', htmlUrl: 'https://example.invalid/repo' };
  const [first, second] = await Promise.all([rpc('import_project', [repository, admin, 100]), rpc('import_project', [repository, worker, 100])]);
  assert.equal(first, second);
  const original = (await db.query<Row>('select * from techunter.projects where id=$1', [first])).rows[0]!;
  await db.query("update techunter.projects set source_branch='release' where id=$1", [first]);
  assert.equal(await rpc('import_project', [repository, other, 100]), first);
  const after = (await db.query<Row>('select * from techunter.projects where id=$1', [first])).rows[0]!;
  assert.equal(after['source_branch'], 'release'); assert.equal(after['imported_by'], original['imported_by']);
  assert.equal(Number((await db.query<Row>("select balance from techunter.point_accounts where owner_type='project' and owner_id=$1 and bucket='available'", [first])).rows[0]!['balance']), 100);
});

test('same email prefixes do not collide and simultaneous login creates one stable identity', async () => {
  const id = randomUUID();
  const [first, retry] = await Promise.all([rpc('upsert_conexus_user', [id, 'sam@one.invalid', 'Sam', false]), rpc('upsert_conexus_user', [id, 'sam@one.invalid', 'Sam', false])]);
  const second = await rpc('upsert_conexus_user', [randomUUID(), 'sam@two.invalid', 'Sam', false]);
  assert.equal(first['id'], retry['id']); assert.notEqual(first['login'], second['login']);
  await db.query("update techunter.users set role='maintainer' where id=$1", [first['id']]);
  assert.equal((await rpc('upsert_conexus_user', [id, 'renamed@one.invalid', 'Renamed', false]))['role'], 'maintainer');
  const collisionId = randomUUID();
  await db.query('insert into techunter.users(login,name) values($1,$2)', [`hunter-${collisionId.replaceAll('-', '')}`, 'legacy']);
  assert.equal((await rpc('upsert_conexus_user', [collisionId, 'legacy@one.invalid', '', false]))['conexus_user_id'], collisionId);
});

test('integrity functions remain inaccessible to browser database roles', async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const signature of ['import_project(jsonb,uuid,bigint)', 'upsert_conexus_user(uuid,text,text,boolean)', 'begin_task_release(uuid,uuid)', 'finish_task_release(uuid,uuid)', 'create_task_workspace(uuid,uuid,text,text)', 'update_task_workspace(uuid,uuid,jsonb)', 'record_submission_tree(uuid,uuid,text)', 'check_publication_budget_unchecked(uuid,bigint)']) {
      assert.equal((await db.query<Row>('select has_function_privilege($1,$2,$3) as allowed', [role, `techunter.${signature}`, 'execute'])).rows[0]!['allowed'], false);
    }
  }
});
