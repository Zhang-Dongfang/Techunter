// Regression coverage: real migrations and TaskService/GitHubService, fake GitHub only.
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
    eq(key, value) { filters.push(`${key === 'review_json->>verdict' ? "review_json->>'verdict'" : ident(key)} = ${bind(value)}`); return builder; },
    gt(key, value) { filters.push(`${ident(key)} > ${bind(value)}`); return builder; },
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
  const pull = { number: 1, html_url: 'https://example.invalid/pull/1', merged: false, state: 'open', changed_files: 1,
    base: { ref: original.targetBranch, sha: 'a'.repeat(40) }, head: { ref: original.workingBranch, sha: 'b'.repeat(40), repo: { id: serial } } };
  let failRead = false, mergeOnWrite = false, issueWrites = 0, tree = 'c'.repeat(40), mergeCalls = 0;
  const client = {
    request: async () => ({ data: { permissions: { push: true } } }),
    pulls: { get: async () => { if (failRead) throw new Error('GitHub read unavailable'); return { data: { ...pull } }; },
      list() {}, update: async ({ state }) => { pull.state = state; },
      listFiles() {}, merge: async () => { mergeCalls++; pull.merged = true; return { data: { merged: true } }; } },
    git: { getCommit: async () => ({ data: { tree: { sha: tree } } }), getRef: async () => ({ data: { object: { sha: pull.head.sha } } }) },
    issues: { update: async () => { issueWrites++; if (mergeOnWrite) pull.merged = true; }, listComments() {}, createComment: async () => {} },
    paginate: async method => method === client.pulls.listFiles ? [{ filename: 'src/a.ts', status: 'modified' }] : method === client.pulls.list ? [{ ...pull, merged_at: pull.merged ? '2026-09-12' : null }] : [],
  };
  github.client = async () => client;
  return { tasks, github, client, task, submission, project, pull, writes: () => issueWrites, merges: () => mergeCalls,
    failRead: value => { failRead = value; }, mergeDuringWrites: () => { mergeOnWrite = true; }, changeTree: () => { tree = 'd'.repeat(40); } };
}

test('release closes unmerged PRs and aborts safely when a merge wins before or during its writes', async () => {
  for (const timing of ['unmerged', 'before', 'close', 'issue']) {
    const f = await fixture();
    await f.tasks.requestChanges(f.submission, admin, 'Please add a test.', 'fixture');
    if (timing === 'before') f.pull.merged = true;
    if (timing === 'close') f.client.pulls.update = async () => { f.pull.merged = true; throw Object.assign(new Error('merged during close'), { status: 405 }); };
    if (timing === 'issue') f.mergeDuringWrites();
    if (timing === 'unmerged') {
      assert.equal((await f.tasks.releaseTask(f.task, alice, 'fixture')).status, 'open');
      assert.equal(f.pull.state, 'closed');
    } else {
      await assert.rejects(() => f.tasks.releaseTask(f.task, alice, 'fixture'), { code: 'PULL_ALREADY_MERGED' });
      const current = await f.tasks.getTask(f.task);
      assert.equal(current.status, 'active'); assert.equal(current.assignee.id, alice.id); assert.equal(current.pendingOperation, null);
      assert.equal((await f.tasks.acceptSubmission(f.submission, admin, 'fixture')).status, 'accepted');
    }
  }
});

test('release keeps its operation and ownership on a GitHub failure, then retries', async () => {
  const f = await fixture(); await f.tasks.requestChanges(f.submission, admin, 'Please add a test.', 'fixture'); f.failRead(true);
  await assert.rejects(() => f.tasks.releaseTask(f.task, alice, 'fixture'), /read unavailable/);
  const current = await f.tasks.getTask(f.task);
  assert.equal(current.pendingOperation.kind, 'release'); assert.equal(current.assignee.id, alice.id);
  await assert.rejects(() => f.tasks.removeTask(f.task, admin, 'fixture'), { code: 'OPERATION_IN_PROGRESS' });
  f.failRead(false); assert.equal((await f.tasks.releaseTask(f.task, alice, 'fixture')).status, 'open');
});

async function legacyReleased(reclaim = false, newer = false) {
  const f = await fixture(); await f.tasks.requestChanges(f.submission, admin, 'Please add a test.', 'fixture');
  // Persist the outcome an old API could create, without changing its ledger.
  const release = await rpc('begin_task_release', { p_task_id: f.task, p_actor_id: alice.id });
  const token = randomUUID(); await rpc('lease_task_operation', { p_id: release, p_actor_id: alice.id, p_token: token });
  await rpc('finish_task_release', { p_id: release, p_token: token });
  f.pull.merged = true;
  if (reclaim) {
    const row = (await db.query("insert into techunter.users(login,name,github_login) values($1,'Bob',$1) returning *", [`bob-${serial}`])).rows[0];
    f.bob = { ...row, githubLogin: row.github_login };
    await f.tasks.claimTask(f.task, f.bob, 'fixture');
    f.workspace = await f.tasks.createWorkspace(f.task, f.bob, { deviceId: 'bob-device', deviceLabel: 'Bob' });
    await f.tasks.updateWorkspace(f.workspace.id, f.bob, { status: 'running' });
    if (newer) {
      const id = await rpc('begin_submission', { p_task_id: f.task, p_author_id: f.bob.id, p_scope: scope, p_summary: 'newer failed attempt', p_test_output: '', p_files: [], p_review: { verdict: 'changes_requested' } });
      await rpc('finish_submission', { p_submission_id: id, p_succeeded: false, p_pull_url: null });
      assert.equal((await f.tasks.getTask(f.task)).latestSubmission.id, id);
    }
  }
  return f;
}

test('historical merged deliveries restore the original author after release, reassignment, or a newer failed delivery', async () => {
  for (const scenario of ['open', 'reassigned', 'newer']) {
    const f = await legacyReleased(scenario !== 'open', scenario === 'newer');
    assert.ok((await f.tasks.recoverySubmissions(f.task)).some(s => s.id === f.submission));
    const current = await f.tasks.acceptSubmission(f.submission, admin, 'fixture');
    assert.equal(current.status, 'accepted'); assert.equal(current.assignee.id, alice.id); assert.equal(current.latestSubmission.id, f.submission);
    await f.tasks.acceptSubmission(f.submission, admin, 'fixture');
    const transfers = (await db.query("select t.amount::int,a.owner_id from techunter.point_transfers t join techunter.point_accounts a on a.id=t.to_account_id where t.task_id=$1 and t.type='task_settlement'", [f.task])).rows;
    assert.deepEqual(transfers, [{ amount: 100, owner_id: alice.id }]);
    if (f.workspace) assert.equal((await db.query('select status from techunter.workspaces where id=$1', [f.workspace.id])).rows[0].status, 'stopped');
    assert.equal(f.merges(), 0);
  }
});

test('historical recovery validates snapshots and actor/version before changing ownership', async () => {
  const f = await legacyReleased(true); const current = await f.tasks.getTask(f.task);
  await assert.rejects(() => rpc('begin_merged_task_review', { p_submission_id: f.submission, p_actor_id: alice.id, p_version: current.version }), /FORBIDDEN/);
  await db.query("update techunter.users set local_role='maintainer' where id=$1", [alice.id]);
  await assert.rejects(() => rpc('begin_merged_task_review', { p_submission_id: f.submission, p_actor_id: alice.id, p_version: current.version }), /SELF_REVIEW_FORBIDDEN/);
  await db.query("update techunter.users set local_role='member' where id=$1", [alice.id]);
  await assert.rejects(() => rpc('begin_merged_task_review', { p_submission_id: f.submission, p_actor_id: admin.id, p_version: current.version - 1 }), /TASK_VERSION_CONFLICT/);
  f.changeTree(); await assert.rejects(() => f.tasks.acceptSubmission(f.submission, admin, 'fixture'), { code: 'PULL_REVIEW_OUTDATED' });
  assert.equal((await f.tasks.getTask(f.task)).assignee.id, f.bob.id);
  assert.equal((await f.tasks.getTask(f.task)).pendingOperation, null);
});

test('upgrading migration 007 preserves assignments and points and protects new recovery RPCs', async () => {
  const legacy = new PGlite();
  try {
    await legacy.exec('create role anon; create role authenticated; create role service_role;');
    const latest = '202609120008_release_settlement_recovery.sql';
    for (const migration of fs.readdirSync(migrationRoot).filter(name => name.endsWith('.sql') && name < latest).sort()) await legacy.exec(fs.readFileSync(new URL(migration, migrationRoot), 'utf8'));
    const user = (await legacy.query("insert into techunter.users(login,name) values('legacy','Legacy') returning id")).rows[0].id;
    const project = (await legacy.query("insert into techunter.projects(github_repository_id,name,repo_owner,repo_name,clone_url,html_url) values(9000,'Legacy','test','legacy','https://example.invalid/repo','https://example.invalid/repo') returning id")).rows[0].id;
    await legacy.query('select techunter.allocate_project_points($1,100)', [project]);
    await legacy.query("insert into techunter.tasks(project_id,title,publisher_id,status) values($1,'Legacy',$2,'open')", [project, user]);
    const before = (await legacy.query('select id,balance from techunter.point_accounts order by id')).rows;
    await legacy.exec(fs.readFileSync(new URL(latest, migrationRoot), 'utf8'));
    assert.deepEqual((await legacy.query('select id,balance from techunter.point_accounts order by id')).rows, before);
    assert.equal((await legacy.query('select settlement_submission_id from techunter.tasks')).rows[0].settlement_submission_id, null);
    for (const role of ['anon', 'authenticated']) assert.equal((await legacy.query("select has_function_privilege($1,'techunter.abort_task_release(uuid,uuid)','execute') as allowed", [role])).rows[0].allowed, false);
  } finally { await legacy.close(); }
});

test('historical settlement retries a failed Issue write using the pinned submission and the same ledger key', async () => {
  const f = await legacyReleased(true, true); let fail = true;
  const update = f.client.issues.update;
  f.client.issues.update = async args => { if (fail) { fail = false; throw new Error('Issue unavailable after validation'); } return update(args); };
  await assert.rejects(() => f.tasks.acceptSubmission(f.submission, admin, 'fixture'), /Issue unavailable/);
  const current = await f.tasks.getTask(f.task); assert.equal(current.pendingOperation.kind, 'accept'); assert.equal(current.latestSubmission.id, f.submission);
  assert.equal((await f.tasks.acceptSubmission(f.submission, admin, 'fixture')).status, 'accepted');
  assert.equal((await db.query("select count(*)::int as count from techunter.point_transfers where task_id=$1 and type='task_settlement'", [f.task])).rows[0].count, 1);
});
