// Regression tests use in-memory PostgreSQL and fake GitHub only.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { TaskService } from '../dist/task-service.js';
import { GitHubService } from '../dist/github-service.js';

const db = new PGlite({ parsers: { 1184: value => value } });
const ident = name => { assert.match(name, /^[a-z_]+$/); return `"${name}"`; };
async function rpc(name, args) {
  const entries = Object.entries(args);
  const result = await db.query(`select techunter.${ident(name)}(${entries.map(([key], i) => `${ident(key)} => $${i + 1}`).join(',')}) as result`,
    entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value));
  return result.rows[0].result;
}
function from(table) {
  let columns = '*', filters = [], values = [], orders = [], count, one = false;
  const bind = value => { values.push(value); return `$${values.length}`; };
  const builder = {
    select(value = '*') { columns = value; return builder; },
    eq(key, value) { filters.push(`${ident(key)} = ${bind(value)}`); return builder; },
    neq(key, value) { filters.push(`${ident(key)} <> ${bind(value)}`); return builder; },
    is(key, value) { assert.equal(value, null); filters.push(`${ident(key)} is null`); return builder; },
    in(key, value) { filters.push(`${ident(key)} in (${value.map(bind).join(',')})`); return builder; },
    not(key, operator, value) { assert.equal(operator, 'in'); filters.push(`${ident(key)} not in (${value.slice(1, -1).split(',').map(bind).join(',')})`); return builder; },
    order(key, options = {}) { orders.push(`${ident(key)} ${options.ascending === false ? 'desc' : 'asc'}`); return builder; },
    limit(value) { count = value; return builder; },
    maybeSingle() { one = true; return builder; },
    single() { one = true; return builder; },
    async insert(row) {
      const entries = Object.entries(row);
      await db.query(`insert into techunter.${ident(table)} (${entries.map(([key]) => ident(key)).join(',')}) values (${entries.map((_, i) => `$${i + 1}`).join(',')})`,
        entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value));
      return { error: null };
    },
    async then(resolve) {
      try {
        const projection = columns === '*' ? '*' : columns.split(',').map(ident).join(',');
        const result = (await db.query(`select ${projection} from techunter.${ident(table)}${filters.length ? ` where ${filters.join(' and ')}` : ''}${orders.length ? ` order by ${orders.join(',')}` : ''}${count === undefined ? '' : ` limit ${Number(count)}`}`, values)).rows;
        return resolve({ data: one ? result[0] ?? null : result, error: null });
      } catch (error) { return resolve({ data: null, error: { message: error.message } }); }
    },
  };
  return builder;
}
const port = { from, async rpc(name, args) { try { return { data: await rpc(name, args), error: null }; } catch (error) { return { data: null, error: { message: error.message } }; } } };
const scope = { revision: 1, editablePaths: ['src/a.ts'], readonlyPaths: [], deniedPaths: [], visibleTests: [], environment: { setupCommands: [], testCommands: [], networkAllowlist: [] } };

let admin, alice, serial = 0;
const migrationRoot = new URL('../../../infra/supabase/migrations/', import.meta.url);
before(async () => {
  await db.exec('create role anon; create role authenticated; create role service_role;');
  for (const name of fs.readdirSync(migrationRoot).filter(name => name.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(new URL(name, migrationRoot), 'utf8'));
  [admin, alice] = (await db.query("insert into techunter.users(login,name,role,github_login) values('review-admin','Admin','admin','admin'),('review-alice','Alice','member','alice') returning *")).rows.map(row => ({ ...row, githubLogin: row.github_login }));
});
after(() => db.close());

async function fixture() {
  const project = (await db.query("insert into techunter.projects(github_repository_id,name,repo_owner,repo_name,clone_url,html_url,head_sha) values($1,'fixture','test',$3,'https://example.invalid/repo.git','https://example.invalid/repo',$2) returning id", [++serial, 'a'.repeat(40), `fixture-${serial}`])).rows[0].id;
  await rpc('allocate_project_points', { p_project_id: project, p_amount: 100 });
  const task = (await db.query("insert into techunter.tasks(project_id,title,publisher_id,scope_json,base_sha) values($1,'fixture',$2,$3,$4) returning id", [project, admin.id, JSON.stringify(scope), 'a'.repeat(40)])).rows[0].id;
  await rpc('publish_task', { p_task_id: task, p_actor_id: admin.id, p_reward: 100, p_issue_number: serial, p_issue_url: 'https://example.invalid/issues/1' });
  await rpc('claim_task', { p_task_id: task, p_user_id: alice.id });
  const workspace = await rpc('create_task_workspace', { p_task_id: task, p_user_id: alice.id, p_device_id: 'fixture-device', p_device_label: 'fixture' });
  await rpc('update_task_workspace', { p_id: workspace, p_actor_id: alice.id, p_update: { status: 'running' } });
  const submission = await rpc('begin_submission', { p_task_id: task, p_author_id: alice.id, p_scope: scope,
    p_summary: 'fixture', p_test_output: 'fixture', p_files: [{ path: 'src/a.ts', content: 'approved content', encoding: 'utf-8' }],
    p_review: { verdict: 'approved', score: 100, summary: 'fixture' } });
  await rpc('finish_submission', { p_submission_id: submission, p_succeeded: true, p_pull_url: 'https://example.invalid/pull/1' });
  await db.query('update techunter.submissions set reviewed_tree_sha=$1 where id=$2', ['c'.repeat(40), submission]);
  const github = new GitHubService();
  const tasks = new TaskService(github, {}, () => port);
  const original = await tasks.getTask(task);
  const pull = { merged: false, state: 'open', changed_files: 1,
    base: { ref: original.targetBranch, sha: 'a'.repeat(40) }, head: { ref: original.workingBranch, sha: 'b'.repeat(40), repo: { id: serial } } };
  let failRead = false, mergeOnWrite = false, issueWrites = 0, tree = 'c'.repeat(40), mergeCalls = 0;
  const client = {
    pulls: { get: async () => { if (failRead) throw new Error('GitHub read unavailable'); return { data: { ...pull } }; },
      listFiles() {}, merge: async () => { mergeCalls++; pull.merged = true; return { data: { merged: true } }; } },
    git: { getCommit: async () => ({ data: { tree: { sha: tree } } }) },
    issues: { update: async () => { issueWrites++; if (mergeOnWrite) pull.merged = true; }, listComments() {}, createComment: async () => {} },
    paginate: async method => method === client.pulls.listFiles ? [{ filename: 'src/a.ts', status: 'modified' }] : [],
  };
  github.client = async () => client;
  return { tasks, github, task, submission, project, pull, writes: () => issueWrites, merges: () => mergeCalls,
    failRead: value => { failRead = value; }, mergeDuringWrites: () => { mergeOnWrite = true; }, changeTree: () => { tree = 'd'.repeat(40); } };
}

test('Conexus demotion removes inherited admin while retaining explicit local grants', async () => {
  const identity = { p_id: randomUUID(), p_email: 'fixture@example.invalid', p_name: 'Former Admin' };
  const promoted = await rpc('upsert_conexus_user', { ...identity, p_admin: true });
  assert.equal(promoted.role, 'admin'); assert.equal(promoted.local_role, 'member');
  const demoted = await rpc('upsert_conexus_user', { ...identity, p_admin: false });
  assert.equal(demoted.role, 'member'); assert.equal(demoted.conexus_admin, false);
  const f = await fixture();
  await assert.rejects(() => rpc('begin_task_cancel', { p_task_id: f.task, p_actor_id: demoted.id }), /FORBIDDEN/);
  await assert.rejects(() => rpc('begin_task_review', { p_submission_id: f.submission, p_actor_id: demoted.id, p_action: 'accept' }), /FORBIDDEN/);
  for (const localRole of ['maintainer', 'admin']) {
    await db.query('update techunter.users set local_role=$1 where id=$2', [localRole, promoted.id]);
    await rpc('upsert_conexus_user', { ...identity, p_admin: true });
    assert.equal((await rpc('upsert_conexus_user', { ...identity, p_admin: false })).role, localRole);
  }
});

test('migration preserves legacy local roles and makes old Conexus admin elevation revocable', async () => {
  const legacy = new PGlite();
  const name = '202609120006_role_sources_and_merged_reviews.sql';
  try {
    await legacy.exec('create role anon; create role authenticated; create role service_role;');
    for (const migration of fs.readdirSync(migrationRoot).filter(value => value.endsWith('.sql') && value < name).sort()) await legacy.exec(fs.readFileSync(new URL(migration, migrationRoot), 'utf8'));
    const conexusId = randomUUID(), maintainerId = randomUUID();
    await legacy.query("insert into techunter.users(login,name,role,conexus_user_id) values('inherited','Inherited','admin',$1),('maintainer','Maintainer','maintainer',$2),('local','Local','admin',null)", [conexusId, maintainerId]);
    await legacy.exec(fs.readFileSync(new URL(name, migrationRoot), 'utf8'));
    assert.deepEqual((await legacy.query('select login,role,local_role,conexus_admin from techunter.users order by login')).rows, [
      { login: 'inherited', role: 'admin', local_role: 'member', conexus_admin: true },
      { login: 'local', role: 'admin', local_role: 'admin', conexus_admin: false },
      { login: 'maintainer', role: 'maintainer', local_role: 'maintainer', conexus_admin: false },
    ]);
    const updated = (await legacy.query("select techunter.upsert_conexus_user($1,'legacy@example.invalid','Legacy',false) as value", [conexusId])).rows[0].value;
    assert.equal(updated.role, 'member');
  } finally { await legacy.close(); }
});

test('external merge before or during changes requests preserves approval and settles only once', async () => {
  for (const timing of ['before', 'during']) {
    const f = await fixture();
    if (timing === 'before') f.pull.merged = true; else f.mergeDuringWrites();
    await assert.rejects(() => f.tasks.requestChanges(f.submission, admin, 'Please add a test.', 'fixture-token'), { code: 'PULL_ALREADY_MERGED' });
    const task = await f.tasks.getTask(f.task);
    assert.equal(task.status, 'submitted'); assert.equal(task.latestSubmission.status, 'approved'); assert.equal(task.pendingOperation, null);
    if (timing === 'before') assert.equal(f.writes(), 0);
    assert.equal((await f.tasks.acceptSubmission(f.submission, admin, 'fixture-token')).status, 'accepted');
    await f.tasks.acceptSubmission(f.submission, admin, 'fixture-token');
    assert.equal(f.merges(), 0);
    assert.equal((await db.query("select count(*)::int as count from techunter.point_transfers where task_id=$1 and type='task_settlement'", [f.task])).rows[0].count, 1);
  }
});

test('GitHub read failure keeps the changes operation retryable and prevents opposite decisions', async () => {
  const f = await fixture(); f.failRead(true);
  await assert.rejects(() => f.tasks.requestChanges(f.submission, admin, 'Please add a test.', 'fixture-token'), /read unavailable/);
  assert.equal((await f.tasks.getTask(f.task)).pendingOperation.kind, 'request_changes');
  assert.equal(f.writes(), 0);
  await assert.rejects(() => f.tasks.acceptSubmission(f.submission, admin, 'fixture-token'), { code: 'REVIEW_ACTION_CONFLICT' });
  f.failRead(false);
  assert.equal((await f.tasks.requestChanges(f.submission, admin, 'Please add a test.', 'fixture-token')).status, 'active');
});

test('original approved evidence recovers a merge after changes, but never merges an unmerged PR', async () => {
  const f = await fixture();
  await f.tasks.requestChanges(f.submission, admin, 'Please add a test.', 'fixture-token');
  await assert.rejects(() => f.tasks.acceptSubmission(f.submission, admin, 'fixture-token'), { code: 'PULL_NOT_MERGED' });
  assert.equal(f.merges(), 0);
  assert.equal((await f.tasks.getTask(f.task)).status, 'active');
  f.pull.merged = true;
  await assert.rejects(() => f.tasks.acceptSubmission(f.submission, alice, 'fixture-token'), { statusCode: 403 });
  assert.equal((await f.tasks.acceptSubmission(f.submission, admin, 'fixture-token')).status, 'accepted');
  assert.equal(f.merges(), 0);
  await f.tasks.acceptSubmission(f.submission, admin, 'fixture-token');
  assert.equal((await db.query("select count(*)::int as count from techunter.point_transfers where task_id=$1 and type='task_settlement'", [f.task])).rows[0].count, 1);
});

test('merged recovery rejects changed evidence and preserves settlement intent without a refund', async () => {
  const f = await fixture();
  await f.tasks.requestChanges(f.submission, admin, 'Please add a test.', 'fixture-token');
  f.pull.merged = true; f.changeTree();
  await assert.rejects(() => f.tasks.acceptSubmission(f.submission, admin, 'fixture-token'), { code: 'PULL_REVIEW_OUTDATED' });
  assert.equal((await f.tasks.getTask(f.task)).pendingOperation.kind, 'accept');
  await assert.rejects(() => f.tasks.removeTask(f.task, admin, 'fixture-token'), { code: 'OPERATION_IN_PROGRESS' });
  assert.equal((await db.query("select count(*)::int as count from techunter.point_transfers where task_id=$1 and type='task_settlement'", [f.task])).rows[0].count, 0);
});

test('recovery revalidates the task version and request-change aborts fence stale leases', async () => {
  const f = await fixture();
  await f.tasks.requestChanges(f.submission, admin, 'Please add a test.', 'fixture-token');
  const before = await f.tasks.getTask(f.task);
  await assert.rejects(() => rpc('begin_merged_task_review', { p_submission_id: f.submission, p_actor_id: admin.id, p_version: before.version - 1 }), /TASK_VERSION_CONFLICT/);
  const other = await fixture();
  const operation = await rpc('begin_task_review', { p_submission_id: other.submission, p_actor_id: admin.id, p_action: 'request_changes' });
  const token = randomUUID();
  await rpc('lease_task_operation', { p_id: operation, p_actor_id: admin.id, p_token: token });
  await assert.rejects(() => rpc('abort_task_changes', { p_id: operation, p_token: randomUUID() }), /OPERATION_LEASE_LOST/);
  await rpc('abort_task_changes', { p_id: operation, p_token: token });
  assert.equal((await other.tasks.getTask(other.task)).pendingOperation, null);
});

test('new privileged functions are inaccessible to browser roles', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) for (const signature of ['derive_user_role()', 'abort_task_changes(uuid,uuid)', 'begin_merged_task_review(uuid,uuid,integer)']) {
    assert.equal((await db.query('select has_function_privilege($1,$2,$3) as allowed', [role, `techunter.${signature}`, 'execute'])).rows[0].allowed, role === 'service_role');
  }
  for (const role of ['anon', 'authenticated', 'service_role']) for (const signature of ['adopt_revoked_task_operation(uuid,uuid)', 'begin_task_review_before_role_sources(uuid,uuid,text,text)', 'begin_task_cancel_before_role_sources(uuid,uuid)']) {
    assert.equal((await db.query('select has_function_privilege($1,$2,$3) as allowed', [role, `techunter.${signature}`, 'execute'])).rows[0].allowed, false);
  }
});

test('authorized recovery adopts idle operations after reviewer demotion without losing merge intent', async () => {
  const identity = { p_id: randomUUID(), p_email: 'old-reviewer@example.invalid', p_name: 'Old reviewer' };
  const former = await rpc('upsert_conexus_user', { ...identity, p_admin: true });
  const f = await fixture();
  const operation = await rpc('begin_task_review', { p_submission_id: f.submission, p_actor_id: former.id, p_action: 'accept' });
  const token = randomUUID();
  await rpc('lease_task_operation', { p_id: operation, p_actor_id: former.id, p_token: token });
  await rpc('mark_task_review', { p_id: operation, p_token: token, p_phase: 'merged' });
  await rpc('upsert_conexus_user', { ...identity, p_admin: false });
  await assert.rejects(() => rpc('begin_task_review', { p_submission_id: f.submission, p_actor_id: admin.id, p_action: 'accept' }), /OPERATION_IN_PROGRESS/);
  await rpc('release_task_operation', { p_id: operation, p_token: token });
  f.pull.merged = true;
  assert.equal((await f.tasks.acceptSubmission(f.submission, admin, 'fixture-token')).status, 'accepted');
  const saved = (await db.query('select actor_id,payload from techunter.task_operations where id=$1', [operation])).rows[0];
  assert.equal(saved.actor_id, admin.id); assert.equal(saved.payload.phase, 'merged'); assert.equal(saved.payload.originalActorId, former.id);
  assert.equal(f.merges(), 0);

  await rpc('upsert_conexus_user', { ...identity, p_admin: true });
  const other = await fixture();
  const cancellation = await rpc('begin_task_cancel', { p_task_id: other.task, p_actor_id: former.id });
  await rpc('upsert_conexus_user', { ...identity, p_admin: false });
  assert.equal(await rpc('begin_task_cancel', { p_task_id: other.task, p_actor_id: admin.id }), cancellation);
  const cancelToken = randomUUID();
  await rpc('lease_task_operation', { p_id: cancellation, p_actor_id: admin.id, p_token: cancelToken });
  await rpc('finish_task_cancel', { p_id: cancellation, p_token: cancelToken });
  assert.equal((await other.tasks.getTask(other.task)).status, 'cancelled');
});
