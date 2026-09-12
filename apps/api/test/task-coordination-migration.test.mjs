import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const root = '../../infra/supabase/migrations';
const latest = '202609120004_task_coordination.sql';

async function legacy() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  for (const name of fs.readdirSync(root).filter(n => n.endsWith('.sql') && n < latest).sort()) await db.exec(fs.readFileSync(`${root}/${name}`, 'utf8'));
  const [alice, bob] = (await db.query("insert into techunter.users(login,name,role,github_login) values('alice','Alice','admin','Alice.Old'),('bob','Bob','member','Bob.New') returning id")).rows.map(r => r.id);
  const project = (await db.query("insert into techunter.projects(github_repository_id,name,repo_owner,repo_name,clone_url,html_url) values(1,'fixture','test','fixture','https://example.invalid/repo','https://example.invalid/repo') returning id")).rows[0].id;
  const scope = { revision: 1, editablePaths: ['src/a.ts'], readonlyPaths: [], deniedPaths: [], visibleTests: [], environment: { setupCommands: [], testCommands: [], networkAllowlist: [] } };
  const task = async (issue, assignee = alice, status = 'active') => (await db.query('insert into techunter.tasks(project_id,title,publisher_id,assignee_id,status,scope_json,github_issue_number) values($1,$2,$3,$4,$5,$6,$7) returning id', [project, `task-${issue}`, alice, assignee, status, JSON.stringify(scope), issue])).rows[0].id;
  const child = async (parent, branch) => (await db.query("insert into techunter.tasks(project_id,parent_task_id,title,publisher_id,scope_json,target_branch) values($1,$2,'child',$3,$4,$5) returning id", [project, parent, alice, JSON.stringify(scope), branch])).rows[0].id;
  return { db, alice, bob, task, child };
}

test('coordination migration retains legacy child targets, current claims, and released-user branches', async () => {
  const f = await legacy();
  try {
    const parent = await f.task(1), child = await f.child(parent, 'task-1-alice-old');
    await f.db.query("update techunter.tasks set status='accepted' where id=$1", [child]);
    await f.db.query('update techunter.tasks set assignee_id=$1 where id=$2', [f.bob, parent]);
    const current = await f.task(2, f.bob), released = await f.task(3, null, 'open'), fresh = await f.task(4, null, 'open');
    const pendingRelease = (await f.db.query('select techunter.begin_task_release($1,$2) as id', [current, f.bob])).rows[0].id;
    await f.db.query("insert into techunter.claims(task_id,user_id,lease_expires_at,released_at) values($1,$2,now(),now())", [released, f.alice]);
    await f.db.exec(fs.readFileSync(`${root}/${latest}`, 'utf8'));
    const rows = (await f.db.query('select id,working_branch from techunter.tasks')).rows;
    const branch = id => rows.find(r => r.id === id).working_branch;
    assert.equal(branch(parent), 'task-1-alice-old');
    assert.equal(branch(current), 'task-2-bob-new');
    assert.equal(branch(released), 'task-3-alice-old');
    assert.equal(branch(fresh), null);
    assert.equal((await f.db.query('select completed_at from techunter.task_operations where id=$1', [pendingRelease])).rows[0].completed_at, null);
    await assert.rejects(() => f.db.query('update techunter.tasks set title=$1 where id=$2', ['blocked', current]), /OPERATION_IN_PROGRESS/);
    await f.db.query("update techunter.tasks set status='active',assignee_id=$1 where id=$2", [f.bob, fresh]);
    assert.equal((await f.db.query('select working_branch from techunter.tasks where id=$1', [fresh])).rows[0].working_branch, `task-${fresh}`);
  } finally { await f.db.close(); }
});

test('coordination migration refuses to silently discard conflicting historical child branches', async () => {
  const f = await legacy();
  try {
    const parent = await f.task(1);
    await f.child(parent, 'task-1-alice-old'); await f.child(parent, 'task-1-bob-new');
    await assert.rejects(() => f.db.exec(fs.readFileSync(`${root}/${latest}`, 'utf8')), /TASK_BRANCH_RECONCILIATION_REQUIRED/);
    assert.equal((await f.db.query("select column_name from information_schema.columns where table_schema='techunter' and table_name='tasks' and column_name='working_branch'")).rows.length, 0);
  } finally { await f.db.close(); }
});
