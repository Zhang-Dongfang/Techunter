// Regression coverage using in-memory PostgreSQL and fake GitHub only.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

let admin, alice;
const migrationRoot = new URL('../../../infra/supabase/migrations/', import.meta.url);
before(async () => {
  await db.exec('create role anon; create role authenticated; create role service_role;');
  for (const name of fs.readdirSync(migrationRoot).filter(name => name.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(new URL(name, migrationRoot), 'utf8'));
  [admin, alice] = (await db.query("insert into techunter.users(login,name,role,github_login) values('review-admin','Admin','admin','admin'),('review-alice','Alice','member','alice') returning *")).rows.map(row => ({ ...row, githubLogin: row.github_login }));
});
after(() => db.close());

let serial = 500;
async function fixture() {
  const base = 'a'.repeat(40), previousHead = 'b'.repeat(40), reviewedTree = 'c'.repeat(40), deliveredHead = 'd'.repeat(40);
  const repositoryId = ++serial;
  const projectId = (await db.query("insert into techunter.projects(github_repository_id,name,repo_owner,repo_name,clone_url,html_url,head_sha) values($2,'fixture','test',$3,'https://example.invalid/repo.git','https://example.invalid/repo',$1) returning id", [base, repositoryId, `fixture-${repositoryId}`])).rows[0].id;
  await rpc('allocate_project_points', { p_project_id: projectId, p_amount: 100 });
  const taskId = (await db.query("insert into techunter.tasks(project_id,title,publisher_id,scope_json,base_sha) values($1,'fixture',$2,$3,$4) returning id", [projectId, admin.id, JSON.stringify(scope), base])).rows[0].id;
  await rpc('publish_task', { p_task_id: taskId, p_actor_id: admin.id, p_reward: 100, p_issue_number: 1, p_issue_url: 'https://example.invalid/issues/1' });
  await rpc('claim_task', { p_task_id: taskId, p_user_id: alice.id });
  const workspaceId = await rpc('create_task_workspace', { p_task_id: taskId, p_user_id: alice.id, p_device_id: 'fixture-device', p_device_label: 'fixture' });
  await rpc('update_task_workspace', { p_id: workspaceId, p_actor_id: alice.id, p_update: { status: 'running' } });
  const submissionId = await rpc('begin_workspace_submission', {
    p_task_id: taskId, p_author_id: alice.id, p_workspace_id: workspaceId, p_scope: scope,
    p_summary: 'fixture', p_test_output: 'fixture',
    p_files: [{ path: 'src/a.ts', content: 'reviewed content', encoding: 'utf-8', mode: '100644' }],
    p_review: { verdict: 'approved', score: 100, summary: 'fixture' }, p_head_sha: previousHead,
  });
  let branchHead = previousHead, merged = false, interrupt = true, pullLookups = 0;
  let changedTree = false, historyFails = false, commitWrites = 0;
  const branch = (await db.query('select working_branch from techunter.tasks where id=$1', [taskId])).rows[0].working_branch;
  const pull = () => ({ number: 1, merged, merged_at: merged ? '2026-09-12' : null, state: merged ? 'closed' : 'open',
    html_url: 'https://example.invalid/pull/1', changed_files: 1,
    head: { sha: deliveredHead, ref: branch, repo: { id: repositoryId } }, base: { sha: base, ref: 'main' } });
  const client = {
    git: {
      getRef: async () => { if (!branchHead) throw Object.assign(new Error('ref deleted'), { status: 404 }); return { data: { object: { sha: branchHead } } }; },
      getCommit: async ({ commit_sha }) => ({ data: { tree: { sha: commit_sha === deliveredHead ? (changedTree ? 'e'.repeat(40) : reviewedTree) : `${commit_sha}-tree` } } }),
      createBlob: async () => ({ data: { sha: 'blob' } }), createTree: async () => ({ data: { sha: reviewedTree } }),
      createCommit: async ({ parents }) => { commitWrites++; assert.deepEqual(parents, [previousHead]); return { data: { sha: deliveredHead } }; },
      updateRef: async ({ sha }) => { branchHead = sha; },
    },
    pulls: {
      list: async () => { pullLookups++; return { data: [] }; },
      create: async () => ({ data: { html_url: 'https://example.invalid/pull/1' } }),
      get: async () => { pullLookups++; return { data: pull() }; },
      listFiles() {},
      merge: async () => { throw new Error('already merged; never merge a second time'); },
      update: async () => { throw new Error('must never close an already merged PR'); },
    },
    issues: { update: async () => {
      if (interrupt) { interrupt = false; merged = true; branchHead = null; throw new Error('connection lost after PR creation; external merge deleted its branch'); }
    } },
    paginate: async method => {
      if (method === client.pulls.listFiles) return [{ filename: 'src/a.ts', status: 'modified' }];
      assert.equal(method, client.pulls.list); pullLookups++;
      if (historyFails) throw new Error('history unavailable');
      return [pull()];
    },
  };
  const github = new GitHubService(); github.client = async () => client;
  const tasks = new TaskService(github, {}, () => port);
  await assert.rejects(() => tasks.resumeSubmission(submissionId, alice, 'fixture'), /connection lost/);
  assert.equal((await tasks.getTask(taskId)).pendingOperation.kind, 'submit');
  return { tasks, taskId, submissionId, projectId, writes: () => commitWrites,
    changeTree: () => { changedTree = true; }, failHistory: value => { historyFails = value; } };
}

test('deleted merged branch recovers saved or legacy missing PR addresses and settles once', async () => {
  for (const legacy of [false, true]) {
    const f = await fixture();
    assert.equal((await f.tasks.getSubmission(f.submissionId)).pullRequestUrl, 'https://example.invalid/pull/1');
    if (legacy) await db.query('update techunter.submissions set pull_request_url=null where id=$1', [f.submissionId]);
    await f.tasks.resumeSubmission(f.submissionId, alice, 'fixture');
    assert.equal((await f.tasks.getTask(f.taskId)).status, 'submitted');
    await assert.rejects(() => f.tasks.removeTask(f.taskId, admin, 'fixture'), { code: 'PULL_ALREADY_MERGED' });
    assert.equal((await f.tasks.acceptSubmission(f.submissionId, admin, 'fixture')).status, 'accepted');
    await f.tasks.acceptSubmission(f.submissionId, admin, 'fixture');
    assert.equal(f.writes(), 1);
    assert.deepEqual((await db.query("select type,amount::int from techunter.point_transfers where task_id=$1 and type in ('task_refund','task_settlement')", [f.taskId])).rows,
      [{ type: 'task_settlement', amount: 100 }]);
  }
});

test('a historical failed recovery with no PR URL cannot refund and can recover its approved evidence', async () => {
  const f = await fixture();
  const token = crypto.randomUUID();
  await rpc('lease_task_operation', { p_id: f.submissionId, p_actor_id: alice.id, p_token: token });
  await rpc('finish_submission_operation', { p_id: f.submissionId, p_token: token, p_succeeded: false, p_pull_url: null });
  await assert.rejects(() => f.tasks.removeTask(f.taskId, admin, 'fixture'), { code: 'PULL_ALREADY_MERGED' });
  assert.equal((await f.tasks.acceptSubmission(f.submissionId, admin, 'fixture')).status, 'accepted');
});

test('unavailable history or mismatched merged evidence keeps submission occupied and blocks refunds', async () => {
  const f = await fixture(); f.failHistory(true);
  await assert.rejects(() => f.tasks.resumeSubmission(f.submissionId, alice, 'fixture'), /history unavailable/);
  assert.equal((await f.tasks.getTask(f.taskId)).pendingOperation.kind, 'submit');
  f.failHistory(false); f.changeTree();
  await assert.rejects(() => f.tasks.resumeSubmission(f.submissionId, alice, 'fixture'), { code: 'PULL_REVIEW_OUTDATED' });
  await assert.rejects(() => f.tasks.removeTask(f.taskId, admin, 'fixture'), { code: 'OPERATION_IN_PROGRESS' });
  assert.equal((await f.tasks.getSubmission(f.submissionId)).status, 'reviewing');
});

test('review counts aggregate more than 1000 tasks without counting duplicate submissions or self-review', async () => {
  const project = (await db.query("insert into techunter.projects(github_repository_id,name,repo_owner,repo_name,clone_url,html_url) values(9001,'counts','test','counts','https://example.invalid/repo','https://example.invalid/repo') returning id")).rows[0].id;
  const reviewer = (await db.query("insert into techunter.users(login,name,role) values('count-reviewer','Count Reviewer','maintainer') returning id")).rows[0].id;
  const baseline = Number(await rpc('review_queue_count', { p_user_id: reviewer }));
  await db.query("insert into techunter.tasks(project_id,title,publisher_id,assignee_id,status) select $1,'count fixture',$2,$3,'submitted' from generate_series(1,1001)", [project, admin.id, alice.id]);
  await db.query("insert into techunter.submissions(task_id,author_id,status) select id,$2,'approved' from techunter.tasks where project_id=$1", [project, alice.id]);
  await db.query("insert into techunter.submissions(task_id,author_id,status) select id,$2,'approved' from techunter.tasks where project_id=$1 limit 1", [project, alice.id]);
  const before = Number(await rpc('review_queue_count', { p_user_id: reviewer }));
  assert.equal(before, baseline + 1001);
  const self = await rpc('review_queue_count', { p_user_id: alice.id });
  assert.equal(Number(self), 0);
});
