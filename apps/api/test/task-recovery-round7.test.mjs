// Regression coverage: submission withdrawal, lazy GitHub authorization and Desktop requests.
// Real migrations and services; in-memory database, fake GitHub and no paid models.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { PGlite } from '@electric-sql/pglite';
import { TaskService } from '../dist/task-service.js';
import { GitHubService } from '../dist/github-service.js';
import { AssistantService } from '../dist/assistant-service.js';
import { registerAuth } from '../dist/auth.js';
import { encryptCredential } from '../dist/credential-vault.js';

Object.assign(process.env, {
  NODE_ENV: 'test', SUPABASE_URL: 'https://database.fixture.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role-key-never-real',
  TECHUNTER_CREDENTIAL_ENCRYPTION_KEY: 'fixture-encryption-key-never-real-123456789',
  TECHUNTER_PUBLIC_URL: 'http://127.0.0.1:4310',
  GITHUB_CLIENT_ID: 'fixture-client', GITHUB_CLIENT_SECRET: 'fixture-secret',
});
const db = new PGlite({ parsers: { 1184: value => value } });
const ident = name => { assert.match(name, /^[a-z_]+$/); return `"${name}"`; };
async function rpc(name, args) {
  const entries = Object.entries(args);
  return (await db.query(`select techunter.${ident(name)}(${entries.map(([key], i) => `${ident(key)} => $${i + 1}`).join(',')}) as result`,
    entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value))).rows[0].result;
}
function from(table) {
  let columns = '*', filters = [], values = [], orders = [], count, one = false;
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
const scope = { revision: 1, editablePaths: ['src/a.ts', '.github/workflows/ci.yml'], readonlyPaths: [], deniedPaths: [], visibleTests: [], environment: { setupCommands: [], testCommands: [], networkAllowlist: [] } };
const review = { verdict: 'approved', score: 100, summary: 'fixture', findings: [{ criterion: 'works', passed: true, evidence: 'fixture' }], risks: [], deliveryDocument: 'fixture' };
let admin, alice, legacy, serial = 0;
before(async () => {
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const root = new URL('../../../infra/supabase/migrations/', import.meta.url);
  const migration = '202609120009_submission_withdrawal.sql';
  for (const name of fs.readdirSync(root).filter(name => name.endsWith('.sql') && name < migration).sort()) await db.exec(fs.readFileSync(new URL(name, root), 'utf8'));
  [admin, alice] = (await db.query("insert into techunter.users(login,name,role,github_login,conexus_user_id) values('round7-admin','Admin','admin','admin',$1),('round7-alice','Alice','member','alice',$2) returning *", [randomUUID(), randomUUID()])).rows.map(row => ({ ...row, githubLogin: row.github_login }));
  legacy = await submissionFixture('issue');
  legacy.operation = (await db.query('select * from techunter.task_operations where id=$1', [legacy.submission])).rows[0];
  await db.exec(fs.readFileSync(new URL(migration, root), 'utf8'));
});
after(() => db.close());

async function fixture() {
  const project = (await db.query("insert into techunter.projects(github_repository_id,name,repo_owner,repo_name,clone_url,html_url,head_sha) values($1,'fixture','test',$2,'https://example.invalid/repo.git','https://example.invalid/repo',$3) returning id", [++serial, `fixture-${serial}`, 'a'.repeat(40)])).rows[0].id;
  await rpc('allocate_project_points', { p_project_id: project, p_amount: 100 });
  const task = (await db.query("insert into techunter.tasks(project_id,title,publisher_id,scope_json,base_sha) values($1,'fixture',$2,$3,$4) returning id", [project, admin.id, JSON.stringify(scope), 'a'.repeat(40)])).rows[0].id;
  await rpc('publish_task', { p_task_id: task, p_actor_id: admin.id, p_reward: 100, p_issue_number: serial, p_issue_url: 'https://example.invalid/issues/1' });
  await rpc('claim_task', { p_task_id: task, p_user_id: alice.id });
  return { project, task };
}

async function submissionFixture(failure = 'push') {
  const f = await fixture(), github = new GitHubService();
  const state = { failure, head: 'a'.repeat(40), tree: 'c'.repeat(40), pull: null, pushes: 0, modelCalls: 0,
    mergeDuringClose: false, mergeDuringIssue: false, failRead: false, failClose: false, merges: 0 };
  const service = new TaskService(github, { review: async () => { state.modelCalls++; return review; } }, () => port);
  const task = await service.getTask(f.task);
  const client = {
    git: {
      getRef: async () => ({ data: { object: { sha: state.head } } }),
      getCommit: async ({ commit_sha }) => ({ data: { tree: { sha: commit_sha === 'a'.repeat(40) ? 'b'.repeat(40) : state.tree } } }),
      createBlob: async () => ({ data: { sha: 'd'.repeat(40) } }),
      createTree: async () => { if (state.failure === 'tree') throw Object.assign(new Error('invalid tree'), { status: 422 }); return { data: { sha: 'c'.repeat(40) } }; },
      createCommit: async () => ({ data: { sha: 'e'.repeat(40) } }),
      updateRef: async ({ sha }) => { state.pushes++; if (state.failure === 'push') throw Object.assign(new Error('workflow permission required'), { status: 403 }); state.head = sha; },
    },
    pulls: {
      list: async () => ({ data: state.pull?.state === 'open' ? [state.pull] : [] }),
      get: async () => { if (state.failRead) throw new Error('read unavailable'); assert.ok(state.pull); return { data: structuredClone(state.pull) }; },
      create: async () => {
        state.pull = { number: 1, html_url: 'https://example.invalid/pull/1', state: 'open', merged: false, changed_files: 1,
          base: { ref: task.targetBranch, sha: 'a'.repeat(40) }, head: { ref: task.workingBranch, sha: state.head, repo: { id: serial } } };
        return { data: state.pull };
      },
      update: async ({ state: status }) => {
        if (state.failClose) throw new Error('close unavailable');
        if (state.mergeDuringClose) { state.pull.merged = true; state.pull.state = 'closed'; throw Object.assign(new Error('merge won'), { status: 405 }); }
        state.pull.state = status;
      },
      listFiles() {},
      merge: async () => { state.merges++; state.pull.merged = true; return { data: { merged: true } }; },
    },
    issues: {
      update: async () => { if (state.failure === 'issue') throw new Error('issue unavailable'); if (state.mergeDuringIssue) state.pull.merged = true; },
      listComments() {}, createComment: async () => {},
    },
    paginate: async method => {
      if (state.failRead) throw new Error('read unavailable');
      if (method === client.pulls.list) return state.pull ? [{ ...state.pull, merged_at: state.pull.merged ? '2026-09-12' : null }] : [];
      if (method === client.pulls.listFiles) return [{ filename: '.github/workflows/ci.yml', status: 'added' }];
      return [];
    },
  };
  github.client = async () => client;
  const workspace = await service.createWorkspace(f.task, alice, { deviceId: 'round7-device', deviceLabel: 'Fixture' });
  await service.updateWorkspace(workspace.id, alice, { status: 'running' });
  const input = { workspaceId: workspace.id, headSha: state.head, summary: 'Add a workflow', testOutput: '',
    files: [{ path: '.github/workflows/ci.yml', content: 'name: CI\non: push\n', encoding: 'utf-8', mode: '100644' }] };
  await assert.rejects(() => service.submitTask(f.task, alice, input, undefined, 'fixture-token'), /workflow permission|invalid tree|issue unavailable/);
  const submission = (await service.getTask(f.task)).latestSubmission.id;
  return { ...f, service, state, submission, input };
}

const reserved = async project => Number((await db.query("select balance from techunter.point_accounts where owner_id=$1 and bucket='reserved'", [project])).rows[0].balance);

test('migration 009 preserves a real pending 008 submission and allows its safe withdrawal', async () => {
  assert.deepEqual((await db.query('select * from techunter.task_operations where id=$1', [legacy.submission])).rows[0], legacy.operation);
  assert.equal(await reserved(legacy.project), 100);
  legacy.state.failure = '';
  assert.equal((await legacy.service.withdrawSubmission(legacy.submission, alice, 'fixture-token')).status, 'changes_requested');
  assert.equal(legacy.state.pull.state, 'closed'); assert.equal(await reserved(legacy.project), 100);
});

test('permanent errors before tree creation or ref update can be withdrawn without releasing ownership or points', async () => {
  for (const failure of ['tree', 'push']) {
    const f = await submissionFixture(failure);
    const old = await f.service.getTask(f.task);
    assert.equal((await f.service.withdrawSubmission(f.submission, alice, 'fixture-token')).status, 'changes_requested');
    const current = await f.service.getTask(f.task);
    assert.equal(current.status, 'active'); assert.equal(current.assignee.id, alice.id); assert.equal(current.pendingOperation, null);
    assert.equal(current.workingBranch, old.workingBranch); assert.equal(await reserved(f.project), 100);
    assert.equal(f.state.head, 'a'.repeat(40)); assert.equal(f.state.modelCalls, 1);
    await f.service.withdrawSubmission(f.submission, alice, 'fixture-token'); // Idempotent response retry.
    assert.equal((await db.query("select id from techunter.audit_events where entity_id=$1 and action='submission.withdrawal_completed'", [f.submission])).rows.length, 1);
    f.state.failure = '';
    const delivered = await f.service.submitTask(f.task, alice, f.input, undefined, 'fixture-token');
    assert.equal(delivered.status, 'approved'); assert.notEqual(delivered.id, f.submission);
  }
});

test('withdrawal retains pushed branch work, closes PRs, and resumes its intent after an interrupted close', async () => {
  const f = await submissionFixture('issue'); f.state.failure = ''; f.state.failClose = true;
  const pushedHead = f.state.head;
  await assert.rejects(() => f.service.withdrawSubmission(f.submission, alice, 'fixture-token'), /close unavailable/);
  assert.equal((await f.service.getTask(f.task)).pendingOperation.withdrawRequested, true);
  await assert.rejects(() => f.service.removeTask(f.task, admin, 'fixture-token'), { code: 'OPERATION_IN_PROGRESS' });
  f.state.failClose = false;
  assert.equal((await f.service.resumeSubmission(f.submission, alice, 'fixture-token')).status, 'changes_requested');
  assert.equal(f.state.pull.state, 'closed'); assert.equal(f.state.head, pushedHead); assert.equal(f.state.pushes, 1); assert.equal(f.state.modelCalls, 1);
  assert.equal((await f.service.getTask(f.task)).status, 'active');
  await f.service.removeTask(f.task, admin, 'fixture-token');
  assert.equal(await reserved(f.project), 0);
});

test('a missing saved PR URL is reconciled and unavailable GitHub reads never permit withdrawal', async () => {
  const f = await submissionFixture('issue'); f.state.failure = '';
  await db.query('update techunter.submissions set pull_request_url=null where id=$1', [f.submission]);
  f.state.failRead = true;
  await assert.rejects(() => f.service.withdrawSubmission(f.submission, alice, 'fixture-token'), /read unavailable/);
  assert.equal((await f.service.getTask(f.task)).status, 'submitted'); assert.equal(await reserved(f.project), 100);
  f.state.failRead = false;
  const withdrawn = await f.service.resumeSubmission(f.submission, admin, 'fixture-token');
  assert.equal(withdrawn.pullRequestUrl, f.state.pull.html_url); assert.equal(f.state.pull.state, 'closed');
});

test('merges before or during withdrawal restore the approved submission for exactly one original-author settlement', async () => {
  for (const timing of ['before', 'close', 'issue']) {
    const f = await submissionFixture('issue'); f.state.failure = '';
    if (timing === 'before') f.state.pull.merged = true;
    if (timing === 'close') f.state.mergeDuringClose = true;
    if (timing === 'issue') f.state.mergeDuringIssue = true;
    const result = await f.service.withdrawSubmission(f.submission, alice, 'fixture-token');
    assert.equal(result.status, 'approved'); assert.equal((await f.service.getTask(f.task)).status, 'submitted');
    assert.equal(await reserved(f.project), 100);
    await assert.rejects(() => f.service.removeTask(f.task, admin, 'fixture-token'), { code: 'PULL_ALREADY_MERGED' });
    await f.service.acceptSubmission(f.submission, admin, 'fixture-token');
    await f.service.acceptSubmission(f.submission, admin, 'fixture-token');
    assert.equal(f.state.merges, 0); assert.equal(await reserved(f.project), 0);
    const payouts = (await db.query("select amount from techunter.point_transfers where task_id=$1 and type='task_settlement'", [f.task])).rows;
    assert.deepEqual(payouts.map(row => Number(row.amount)), [100]);
    assert.equal((await f.service.getTask(f.task)).assignee.id, alice.id);
  }
});

test('merged content with stale or missing review evidence remains protected from withdrawal and refunds', async () => {
  for (const mismatch of ['tree', 'review', 'missing']) {
    const f = await submissionFixture('issue'); f.state.failure = ''; f.state.pull.merged = true;
    if (mismatch === 'tree') f.state.tree = 'f'.repeat(40);
    if (mismatch === 'review') await db.query("update techunter.submissions set review_json='{}' where id=$1", [f.submission]);
    if (mismatch === 'missing') await db.query('update techunter.submissions set reviewed_tree_sha=null where id=$1', [f.submission]);
    await assert.rejects(() => f.service.withdrawSubmission(f.submission, alice, 'fixture-token'), { code: mismatch === 'tree' ? 'PULL_REVIEW_OUTDATED' : 'PULL_REVIEW_MISSING' });
    await assert.rejects(() => f.service.removeTask(f.task, admin, 'fixture-token'), { code: 'OPERATION_IN_PROGRESS' });
    assert.equal(await reserved(f.project), 100); assert.equal((await f.service.getTask(f.task)).latestSubmission.status, 'reviewing');
  }
});

test('withdrawal enforces author/admin, live leases, and database role restrictions', async () => {
  const f = await submissionFixture();
  await assert.rejects(() => f.service.withdrawSubmission(f.submission, { ...alice, id: randomUUID() }, 'fixture-token'), /不能恢复/);
  const live = randomUUID();
  await rpc('lease_task_operation', { p_id: f.submission, p_actor_id: alice.id, p_token: live });
  await assert.rejects(() => f.service.withdrawSubmission(f.submission, admin, 'fixture-token'), { code: 'OPERATION_IN_PROGRESS' });
  await db.query("update techunter.task_operations set lease_until=now()-interval '1 second' where id=$1", [f.submission]);
  await assert.rejects(() => rpc('mark_submission_withdrawal', { p_id: f.submission, p_actor_id: alice.id, p_token: live }), /OPERATION_LEASE_LOST/);
  for (const role of ['anon', 'authenticated']) for (const signature of ['mark_submission_withdrawal(uuid,uuid,uuid)', 'finish_submission_withdrawal(uuid,uuid,uuid,text,boolean)']) {
    assert.equal((await db.query('select has_function_privilege($1,$2,\'execute\') as allowed', [role, `techunter.${signature}`])).rows[0].allowed, false);
  }
  f.state.failure = '';
  assert.equal((await f.service.withdrawSubmission(f.submission, admin, 'fixture-token')).status, 'changes_requested');
});

test('GitHub refresh outages do not affect account/dashboard/Conexus routes; writes still fail explicitly and reauthorization includes workflows', async () => {
  await db.query("insert into techunter.github_connections(user_id,credential,refresh_credential,access_expires_at,refresh_expires_at) values($1,$2,$3,now()-interval '1 minute',now()+interval '1 day')", [alice.id, encryptCredential('fixture-old-token'), encryptCredential('fixture-refresh-token')]);
  const originalFetch = globalThis.fetch;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const session = { user_id: alice.id, expires_at: new Date(Date.now() + 30 * 86400000).toISOString(), idle_expires_at: new Date(Date.now() + 7 * 86400000).toISOString() };
  let refreshCalls = 0, dashboardCalls = 0, introspectionCalls = 0, tokenStatus = 503;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.href === 'https://github.com/login/oauth/access_token') { refreshCalls++; return json({ error: 'fixture outage' }, tokenStatus); }
    assert.equal(url.hostname, 'database.fixture.invalid', 'All external calls must use fixtures');
    const name = url.pathname.split('/').at(-1);
    if (url.pathname.includes('/rpc/')) return json(await rpc(name, await request.json()));
    if (name === 'sessions') return request.method === 'PATCH' ? new Response(null, { status: 204 }) : json([session]);
    if (name === 'audit_events') return new Response(null, { status: 201 });
    if (name === 'users') return json((await db.query('select * from techunter.users where id=$1', [alice.id])).rows[0]);
    if (name === 'github_connections') return json((await db.query('select * from techunter.github_connections where user_id=$1', [alice.id])).rows);
    throw new Error(`Unhandled fixture request: ${request.method} ${name}`);
  };
  const app = Fastify();
  try {
    await app.register(cookie);
    registerAuth(app, { introspect: async () => { introspectionCalls++; return { user: { id: alice.conexus_user_id, email: 'fixture@example.invalid', name: 'Alice', role: 'user' }, audience: 'http://127.0.0.1:4310', expiresAt: new Date(Date.now()+600000).toISOString() }; } });
    app.get('/api/dashboard', () => { dashboardCalls++; return { ok: true }; });
    app.get('/api/github-needed', async request => ({ credentials: await Promise.all([request.getGitHubCredential(), request.getGitHubCredential()]) }));
    const headers = { cookie: 'techunter_session=fixture-session' };
    for (const options of [{ url: '/api/dashboard' }, { url: '/api/auth/me' }, { method: 'POST', url: '/api/auth/conexus/refresh', payload: { runTicket: 'cnx_run_v1.fixture', audience: 'http://127.0.0.1:4310' } }]) {
      const response = await app.inject({ ...options, headers }); assert.equal(response.statusCode, 200, response.body);
    }
    assert.equal(dashboardCalls, 1); assert.equal(introspectionCalls, 1); assert.equal(refreshCalls, 0);
    assert.equal((await app.inject({ url: '/api/github-needed', headers })).statusCode, 502);
    assert.equal(refreshCalls, 1);
    tokenStatus = 400;
    assert.equal((await app.inject({ url: '/api/github-needed', headers })).statusCode, 401);
    assert.equal(refreshCalls, 2, 'each request shares one lazy refresh; invalid tokens never fall back silently');
    const begin = await app.inject({ method: 'POST', url: '/api/auth/github', headers });
    assert.equal(begin.statusCode, 200);
    assert.ok(new URL(begin.json().authorizationUrl).searchParams.get('scope').split(' ').includes('workflow'));
    const me = (await app.inject({ url: '/api/auth/me', headers })).json();
    assert.equal(me.githubConnected, true); assert.equal(me.githubConnectionVersion, begin.json().connectionVersion);
    assert.equal(refreshCalls, 2);
  } finally { await app.close(); globalThis.fetch = originalFetch; }
});

test('assistant emits one structured Desktop request with the real task, workspace and device IDs', async () => {
  const f = await fixture(), service = new TaskService({}, {}, () => port);
  const project = await service.getProject(f.project), requests = [];
  const assistant = new AssistantService(service, {});
  const tools = assistant.taskTools({ user: alice, deviceId: 'assistant-device', deviceLabel: 'Fixture' }, project, requests);
  const execute = tools.find(tool => tool.definition.function.name === 'create_workspace').execute;
  const workspace = JSON.parse(await execute({ task_id: f.task }));
  await execute({ task_id: f.task });
  assert.equal(workspace.status, 'queued');
  assert.deepEqual(requests, [{ taskId: f.task, workspaceId: workspace.id, deviceId: 'assistant-device' }]);
});
