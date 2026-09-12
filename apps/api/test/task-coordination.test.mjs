// In-memory PostgreSQL and fake GitHub; no network or paid model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { before, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { TaskService } from '../dist/task-service.js';
import { GitHubService } from '../dist/github-service.js';
import { AssistantService } from '../dist/assistant-service.js';
import { httpError } from '../dist/errors.js';

// Match PostgREST timestamp strings without dropping PostgreSQL microseconds.
const db = new PGlite({ parsers: { 1184: value => value } });
const ident = name => { assert.match(name, /^[a-z_]+$/); return `"${name}"`; };
async function rpc(name, args) {
  const entries = Object.entries(args);
  const result = await db.query(`select techunter.${ident(name)}(${entries.map(([key], i) => `${ident(key)} => $${i + 1}`).join(',')}) as result`,
    entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value));
  return result.rows[0].result;
}
// A small Supabase port adapter; actual services and migration functions run unchanged.
function from(table) {
  let columns = '*', filters = [], values = [], orders = [], count, one = false, patch;
  const bind = value => { values.push(value); return `$${values.length}`; };
  const builder = {
    select(value = '*') { columns = value; return builder; },
    eq(key, value) { filters.push(`${ident(key)} = ${bind(value)}`); return builder; },
    gt(key, value) { filters.push(`${ident(key)} > ${bind(value)}`); return builder; },
    neq(key, value) { filters.push(`${ident(key)} <> ${bind(value)}`); return builder; },
    is(key, value) { assert.equal(value, null); filters.push(`${ident(key)} is null`); return builder; },
    in(key, value) { filters.push(`${ident(key)} in (${value.map(bind).join(',')})`); return builder; },
    not(key, operator, value) { assert.equal(operator, 'in'); filters.push(`${ident(key)} not in (${value.slice(1, -1).split(',').map(bind).join(',')})`); return builder; },
    order(key, options = {}) { orders.push(`${ident(key)} ${options.ascending === false ? 'desc' : 'asc'}`); return builder; },
    limit(value) { count = value; return builder; },
    maybeSingle() { one = true; return builder; },
    single() { one = true; return builder; },
    update(value) { patch = value; return builder; },
    async insert(row) {
      const entries = Object.entries(row);
      await db.query(`insert into techunter.${ident(table)} (${entries.map(([key]) => ident(key)).join(',')}) values (${entries.map((_, i) => `$${i + 1}`).join(',')})`,
        entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value));
      return { error: null };
    },
    async then(resolve, reject) {
      try {
        const projection = columns === '*' ? '*' : columns.split(',').map(ident).join(',');
        let query;
        if (patch) {
          const set = Object.entries(patch).map(([key, value]) => `${ident(key)} = ${bind(value)}`).join(',');
          query = `update techunter.${ident(table)} set ${set}${filters.length ? ` where ${filters.join(' and ')}` : ''} returning ${projection}`;
        } else query = `select ${projection} from techunter.${ident(table)}${filters.length ? ` where ${filters.join(' and ')}` : ''}${orders.length ? ` order by ${orders.join(',')}` : ''}${count === undefined ? '' : ` limit ${Number(count)}`}`;
        const result = (await db.query(query, values)).rows;
        return resolve({ data: one ? result[0] ?? null : result, error: null });
      } catch (error) { return resolve({ data: null, error: { message: error.message } }); }
    },
  };
  return builder;
}
const port = { from, async rpc(name, args) { try { return { data: await rpc(name, args), error: null }; } catch (error) { return { data: null, error: { message: error.message } }; } } };
const scope = { revision: 1, editablePaths: ['src/a.ts'], readonlyPaths: [], deniedPaths: [], visibleTests: [], environment: { setupCommands: [], testCommands: [], networkAllowlist: [] } };
let admin, alice, bob, serial = 0;
async function fixture() {
  const project = (await db.query("insert into techunter.projects(github_repository_id,name,repo_owner,repo_name,clone_url,html_url,head_sha) values($1,'fixture','test',$2,'https://example.invalid/repo.git','https://example.invalid/repo',$3) returning id", [++serial, `fixture-${serial}`, 'a'.repeat(40)])).rows[0].id;
  await rpc('allocate_project_points', { p_project_id: project, p_amount: 100 });
  const task = (await db.query("insert into techunter.tasks(project_id,title,publisher_id,scope_json,base_sha) values($1,'fixture',$2,$3,$4) returning id", [project, admin.id, JSON.stringify(scope), 'a'.repeat(40)])).rows[0].id;
  await rpc('publish_task', { p_task_id: task, p_actor_id: admin.id, p_reward: 100, p_issue_number: serial, p_issue_url: 'https://example.invalid/issues/1' });
  return { project, task };
}
async function approved(task, user = alice) {
  await rpc('claim_task', { p_task_id: task, p_user_id: user.id });
  const workspace = await rpc('create_task_workspace', { p_task_id: task, p_user_id: user.id, p_device_id: 'device-a', p_device_label: 'A' });
  await rpc('update_task_workspace', { p_id: workspace, p_actor_id: user.id, p_update: { status: 'running' } });
  const submission = await rpc('begin_submission', { p_task_id: task, p_author_id: user.id, p_scope: scope, p_summary: 'fixture', p_test_output: 'ok', p_files: [{ path: 'src/a.ts', content: 'test', encoding: 'utf-8' }], p_review: { verdict: 'approved' } });
  await rpc('finish_submission', { p_submission_id: submission, p_succeeded: true, p_pull_url: 'https://example.invalid/pull/1' });
  await db.query('update techunter.submissions set reviewed_tree_sha=$1 where id=$2', ['c'.repeat(40), submission]);
  return submission;
}

before(async () => {
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const root = '../../infra/supabase/migrations';
  for (const name of fs.readdirSync(root).filter(name => name.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(`${root}/${name}`, 'utf8'));
  [admin, alice, bob] = (await db.query("insert into techunter.users(login,name,role,github_login) values('coord-admin','Admin','admin','admin'),('coord-alice','Alice','member','alice'),('coord-bob','Bob','member','bob') returning *")).rows.map(row => ({ ...row, githubLogin: row.github_login }));
});
after(async () => { await db.close(); });
function barrier() {
  let enter, release;
  return { ready: new Promise(resolve => { enter = resolve; }), wait: new Promise(resolve => { release = resolve; }), enter: () => enter(), release: () => release() };
}
const transfers = async (task, type) => (await db.query('select amount from techunter.point_transfers where task_id=$1 and type=$2', [task, type])).rows;

test('acceptance excludes cancellation both through service and legacy RPC, then settles once', async () => {
  const f = await fixture(), submission = await approved(f.task), gate = barrier();
  let mergeCount = 0;
  const service = new TaskService({
    async completeTask(_task, _project, _url, _credential, reviewed) {
      await reviewed.beforeMerge(); mergeCount++; await reviewed.onMerged(); gate.enter(); await gate.wait;
    },
    async cancelTask() { assert.fail('cancellation must not reach GitHub'); },
  }, {}, () => port);
  const accepting = service.acceptSubmission(submission, admin);
  await gate.ready;
  try {
    await assert.rejects(() => service.removeTask(f.task, admin), { code: 'OPERATION_IN_PROGRESS' });
    await assert.rejects(() => rpc('admin_remove_task', { p_task_id: f.task, p_actor_id: admin.id }), /OPERATION_IN_PROGRESS/);
    await assert.rejects(() => service.acceptSubmission(submission, admin), { code: 'OPERATION_IN_PROGRESS' });
  } finally { gate.release(); }
  assert.equal((await accepting).status, 'accepted');
  await service.acceptSubmission(submission, admin);
  assert.equal(mergeCount, 1);
  assert.equal((await transfers(f.task, 'task_refund')).length, 0);
});

test('cancellation reserves the task before GitHub writes and refunds only once on retry', async () => {
  const f = await fixture(), submission = await approved(f.task), gate = barrier();
  let closes = 0;
  const service = new TaskService({ async cancelTask() { closes++; gate.enter(); await gate.wait; } }, {}, () => port);
  const cancelling = service.removeTask(f.task, admin);
  await gate.ready;
  try { await assert.rejects(() => service.acceptSubmission(submission, admin), { code: 'OPERATION_IN_PROGRESS' }); }
  finally { gate.release(); }
  await cancelling;
  await service.removeTask(f.task, admin);
  assert.equal(closes, 1);
  assert.equal((await service.getTask(f.task)).status, 'cancelled');
  assert.deepEqual((await transfers(f.task, 'task_refund')).map(row => Number(row.amount)), [100]);
});

test('definite merge refusal releases review intent and allows changes then a new delivery', async () => {
  const f = await fixture(), submission = await approved(f.task);
  const service = new TaskService({
    async completeTask(_task, _project, _url, _credential, reviewed) {
      await reviewed.beforeMerge(); throw httpError('fixture merge refused', 409, 'GITHUB_MERGE_REJECTED');
    }, async syncChangesNeeded() {},
  }, {}, () => port);
  await assert.rejects(() => service.acceptSubmission(submission, admin), { code: 'GITHUB_MERGE_REJECTED' });
  assert.equal((await service.getTask(f.task)).pendingOperation, null);
  assert.equal((await service.requestChanges(submission, admin, 'Resolve conflict')).status, 'active');
  const next = await rpc('begin_submission', { p_task_id: f.task, p_author_id: alice.id, p_scope: scope, p_summary: 'fixed', p_test_output: 'ok', p_files: [{ path: 'src/a.ts', content: 'fixed' }], p_review: { verdict: 'approved' } });
  assert.notEqual(next, submission);
});

test('unknown merge outcomes retain intent across retries and forbid cancellation or changes', async () => {
  const f = await fixture(), submission = await approved(f.task);
  let timedOut = true;
  const service = new TaskService({ async completeTask(_task, _project, _url, _credential, reviewed) {
    await reviewed.beforeMerge();
    if (timedOut) throw new Error('transport timeout');
    await reviewed.onMerged();
  } }, {}, () => port);
  await assert.rejects(() => service.acceptSubmission(submission, admin), /transport timeout/);
  assert.equal((await service.getTask(f.task)).pendingOperation.kind, 'accept');
  await assert.rejects(() => service.removeTask(f.task, admin), { code: 'OPERATION_IN_PROGRESS' });
  await assert.rejects(() => service.requestChanges(submission, admin, 'no'), { code: 'REVIEW_ACTION_CONFLICT' });
  timedOut = false;
  assert.equal((await service.acceptSubmission(submission, admin)).status, 'accepted');
  assert.equal((await transfers(f.task, 'task_refund')).length, 0);
});

test('already merged PR cancels the cancellation operation and remains available for settlement', async () => {
  const f = await fixture(), submission = await approved(f.task);
  const service = new TaskService({
    async cancelTask() { throw httpError('already merged', 409, 'PULL_ALREADY_MERGED'); },
    async completeTask(_task, _project, _url, _credential, reviewed) { await reviewed.onMerged(); },
  }, {}, () => port);
  await assert.rejects(() => service.removeTask(f.task, admin), { code: 'PULL_ALREADY_MERGED' });
  assert.equal((await service.getTask(f.task)).pendingOperation, null);
  assert.equal((await service.acceptSubmission(submission, admin)).status, 'accepted');
  assert.equal((await transfers(f.task, 'task_refund')).length, 0);
});

test('task reassignment keeps accepted child work on the same integration branch', async () => {
  const f = await fixture(), refs = new Map();
  let failFirstSync = true;
  const github = new GitHubService();
  github.assertClaimPermission = async () => {};
  github.client = async () => ({ pulls: { list() {} }, paginate: async () => [], git: {
    async getRef({ ref }) { if (!refs.has(ref)) throw Object.assign(new Error('missing ref'), { status: 404 }); return { data: { object: { sha: refs.get(ref) } } }; },
    async createRef({ ref, sha }) { refs.set(ref.replace(/^refs\//, ''), sha); return { data: { object: { sha } } }; },
  }, issues: { async update() { if (failFirstSync) { failFirstSync = false; throw new Error('lost claim sync response'); } } } });
  const service = new TaskService(github, {}, () => port);
  await assert.rejects(() => service.claimTask(f.task, alice, 'fixture-token'), /lost claim sync/);
  assert.equal(refs.size, 1);
  const parent = await service.claimTask(f.task, alice, 'fixture-token');
  const child = (await db.query("insert into techunter.tasks(project_id,parent_task_id,title,publisher_id,scope_json,base_sha,target_branch) values($1,$2,'child',$3,$4,$5,$6) returning id", [f.project, f.task, alice.id, JSON.stringify(scope), parent.baseSha, parent.workingBranch])).rows[0].id;
  await rpc('publish_task', { p_task_id: child, p_actor_id: alice.id, p_reward: 40, p_issue_number: 1000 + serial, p_issue_url: 'https://example.invalid/issues/2' });
  const childSubmission = await approved(child, bob);
  await rpc('start_submission_review', { p_submission_id: childSubmission, p_reviewer_id: admin.id, p_action: 'accept' });
  await rpc('accept_task', { p_submission_id: childSubmission, p_reviewer_id: admin.id });
  const childMerge = 'd'.repeat(40); refs.set(`heads/${parent.workingBranch}`, childMerge);
  await service.releaseTask(f.task, alice, 'fixture-token');
  const reassigned = await service.claimTask(f.task, bob, 'fixture-token');
  assert.equal(reassigned.workingBranch, parent.workingBranch);
  assert.equal(refs.get(`heads/${reassigned.workingBranch}`), childMerge);
  assert.equal(refs.size, 1);
  await assert.rejects(() => db.query('update techunter.tasks set working_branch=$1 where id=$2', ['replacement', f.task]), /TASK_VERSION_CONFLICT/);
});

test('claim read failure is recoverable after restart and cannot be stolen or duplicated', async () => {
  const f = await fixture(); let githubCalls = 0;
  const github = { async assertClaimPermission() {}, async syncClaim() { githubCalls++; } };
  const broken = new TaskService(github, {}, () => port);
  const getTask = broken.getTask.bind(broken); let reads = 0;
  broken.getTask = async id => { if (++reads === 2) throw new Error('transient database read failure'); return getTask(id); };
  await assert.rejects(() => broken.claimTask(f.task, alice, 'fixture-token'), /transient database/);
  const service = new TaskService(github, {}, () => port);
  await assert.rejects(() => service.claimTask(f.task, bob, 'fixture-token'), { code: 'OPERATION_IN_PROGRESS' });
  assert.equal((await service.claimTask(f.task, alice, 'fixture-token')).status, 'active');
  await service.claimTask(f.task, alice, 'fixture-token');
  assert.equal(githubCalls, 1);
  assert.equal((await db.query('select id from techunter.claims where task_id=$1', [f.task])).rows.length, 1);
});

test('failed device B does not block running A; a workspace becoming invalid during review is rejected', async () => {
  const f = await fixture(); await rpc('claim_task', { p_task_id: f.task, p_user_id: alice.id });
  const create = async (device, status) => {
    const id = await rpc('create_task_workspace', { p_task_id: f.task, p_user_id: alice.id, p_device_id: device, p_device_label: device });
    await rpc('update_task_workspace', { p_id: id, p_actor_id: alice.id, p_update: { status } }); return id;
  };
  const a = await create('A', 'running'), b = await create('B', 'failed');
  let invalidate = false, reviews = 0;
  const service = new TaskService({
    async assertSubmissionHead() {},
    async publishSubmission(_task, _project, _files, _review, _credential, operation) { await operation.recordTree('c'.repeat(40)); return 'https://example.invalid/pull/1'; },
  }, { async review() { reviews++; if (invalidate) await rpc('update_task_workspace', { p_id: a, p_actor_id: alice.id, p_update: { status: 'failed' } }); return { verdict: 'approved' }; } }, () => port);
  const input = { files: [{ path: 'src/a.ts', content: 'new', encoding: 'utf-8' }], headSha: 'a'.repeat(40), summary: 'fixture', testOutput: 'ok' };
  const snapshot = await service.getTask(f.task);
  assert.equal(snapshot.workspaces.find(w => w.id === a).status, 'running');
  assert.equal(snapshot.workspaces.find(w => w.id === b).status, 'failed');
  await assert.rejects(() => service.submitTask(f.task, alice, { ...input, workspaceId: b }), { code: 'WORKSPACE_NOT_READY' });
  assert.equal(reviews, 0);
  invalidate = true;
  await assert.rejects(() => service.submitTask(f.task, alice, { ...input, workspaceId: a }), /WORKSPACE_NOT_READY|尚未准备/);
  assert.equal((await service.getTask(f.task)).latestSubmission, null);
  invalidate = false;
  await rpc('update_task_workspace', { p_id: a, p_actor_id: alice.id, p_update: { status: 'running' } });
  assert.equal((await service.submitTask(f.task, alice, { ...input, workspaceId: a })).status, 'approved');
});

test('same-user reclaim invalidates every old device workspace including failed ones', async () => {
  const f = await fixture(); await rpc('claim_task', { p_task_id: f.task, p_user_id: alice.id });
  const old = await rpc('create_task_workspace', { p_task_id: f.task, p_user_id: alice.id, p_device_id: 'A', p_device_label: 'A' });
  await rpc('update_task_workspace', { p_id: old, p_actor_id: alice.id, p_update: { status: 'failed' } });
  const service = new TaskService({ async assertClaimPermission() {}, async syncRelease() {}, async syncClaim() {} }, {}, () => port);
  await service.releaseTask(f.task, alice, 'fixture-token');
  await service.claimTask(f.task, alice, 'fixture-token');
  await assert.rejects(() => service.updateWorkspace(old, alice, { status: 'running' }));
  const fresh = await service.createWorkspace(f.task, alice, { deviceId: 'A', deviceLabel: 'A' });
  assert.notEqual(fresh.id, old);
});

test('slow project sync cannot revert a concurrent branch switch, even after switching back', async () => {
  for (const switchBack of [false, true]) {
    const f = await fixture(), gate = barrier(); let firstMain = true, mainHead = 'b'.repeat(40);
    const service = new TaskService({ async repository(_id, _credential, branch) {
      const headSha = branch === 'main' ? mainHead : 'c'.repeat(40);
      if (branch === 'main' && firstMain) { firstMain = false; gate.enter(); await gate.wait; }
      return { name: `fixture-${f.project}`, description: '', owner: 'test', cloneUrl: 'https://example.invalid/repo.git', htmlUrl: 'https://example.invalid/repo', defaultBranch: 'main', visibility: 'private', permissions: { pull: true }, headSha };
    } }, {}, () => port);
    const syncing = service.syncProject(f.project, alice, 'fixture-token'); await gate.ready;
    try {
      await service.switchProjectBranch(f.project, 'release', admin, 'fixture-token');
      if (switchBack) { mainHead = 'd'.repeat(40); await service.switchProjectBranch(f.project, 'main', admin, 'fixture-token'); }
    } finally { gate.release(); }
    const result = await syncing;
    assert.equal(result.sourceBranch, switchBack ? 'main' : 'release');
    assert.equal(result.headSha, (switchBack ? 'd' : 'c').repeat(40));
  }
});

test('assistant direct mode creates and analyzes without Conexus; missing Conexus fails before draft', async () => {
  for (const mode of ['direct', 'conexus']) {
    const calls = [];
    const service = new AssistantService({
      async syncProject() { calls.push('sync'); },
      async createDraft() { calls.push('draft'); return { id: 'fixture' }; },
      async analyzeTask(_id, _user, authorization) { assert.equal(authorization, undefined); calls.push('analyze'); },
      async getTask() { return { id: 'fixture', status: 'draft' }; },
    }, {}, () => ({ ai: { accessMode: mode } }));
    const tool = service.taskTools({ user: alice, githubCredential: 'fixture-token' }, { id: 'project' }).find(tool => tool.definition.function.name === 'create_task');
    const create = () => tool.execute({ title: 'Fixture task', description: 'Fixture description' });
    if (mode === 'direct') { await create(); assert.deepEqual(calls, ['sync', 'draft', 'analyze']); }
    else { await assert.rejects(create, { code: 'CONEXUS_AUTHORIZATION_REQUIRED' }); assert.deepEqual(calls, []); }
  }
});

test('coordination RPCs exclude untrusted database roles and fence stale leases', async () => {
  const signatures = ['begin_task_claim(uuid,uuid)', 'begin_task_review(uuid,uuid,text,text)', 'begin_task_cancel(uuid,uuid)', 'finish_task_review(uuid,uuid)', 'abort_task_cancel(uuid,uuid)', 'begin_workspace_submission(uuid,uuid,uuid,jsonb,text,text,jsonb,jsonb,text)'];
  for (const signature of signatures) for (const role of ['anon', 'authenticated', 'service_role']) {
    const result = (await db.query('select has_function_privilege($1,$2,$3) as allowed', [role, `techunter.${signature}`, 'EXECUTE'])).rows[0];
    assert.equal(result.allowed, role === 'service_role', `${role}: ${signature}`);
  }
  for (const signature of ['admin_remove_task_unchecked(uuid,uuid)', 'start_submission_review_unchecked(uuid,uuid,text)']) {
    assert.equal((await db.query("select has_function_privilege('service_role',$1,'EXECUTE') as allowed", [`techunter.${signature}`])).rows[0].allowed, false);
  }
  const f = await fixture(), submission = await approved(f.task);
  const op = await rpc('begin_task_review', { p_submission_id: submission, p_actor_id: admin.id, p_action: 'accept' });
  const token = '00000000-0000-4000-8000-000000000001', stale = '00000000-0000-4000-8000-000000000002';
  await rpc('lease_task_operation', { p_id: op, p_actor_id: admin.id, p_token: token });
  for (const name of ['finish_task_review', 'abort_task_review']) await assert.rejects(() => rpc(name, { p_id: op, p_token: stale }), /OPERATION_LEASE_LOST/);
  await assert.rejects(() => rpc('finish_task_review', { p_id: op, p_token: token }), /REVIEW_ACTION_CONFLICT/);
  await rpc('mark_task_review', { p_id: op, p_token: token, p_phase: 'merged' });
  await assert.rejects(() => rpc('abort_task_review', { p_id: op, p_token: token, p_definitely_unmerged: true }), /REVIEW_ACTION_CONFLICT/);
});
