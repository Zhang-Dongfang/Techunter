// Isolated review reproductions. Assertions describe defects at commit 56c25d0.
// Run after building core/API: node --test docs/diagnostics/review-round7.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { PGlite } from '@electric-sql/pglite';
import { TaskService } from '../../apps/api/dist/task-service.js';
import { GitHubService } from '../../apps/api/dist/github-service.js';
import { AssistantService } from '../../apps/api/dist/assistant-service.js';
import { registerAuth } from '../../apps/api/dist/auth.js';
import { encryptCredential } from '../../apps/api/dist/credential-vault.js';

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
let admin, alice, serial = 0;
before(async () => {
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const root = new URL('../../infra/supabase/migrations/', import.meta.url);
  for (const name of fs.readdirSync(root).filter(name => name.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(new URL(name, root), 'utf8'));
  [admin, alice] = (await db.query("insert into techunter.users(login,name,role,github_login,conexus_user_id) values('round7-admin','Admin','admin','admin',$1),('round7-alice','Alice','member','alice',$2) returning *", [randomUUID(), randomUUID()])).rows.map(row => ({ ...row, githubLogin: row.github_login }));
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

test('permanent GitHub workflow rejection leaves a submission blocking every exit', async () => {
  const f = await fixture(), github = new GitHubService();
  let pushAttempts = 0, modelCalls = 0;
  github.client = async () => ({
    git: {
      getRef: async () => ({ data: { object: { sha: 'a'.repeat(40) } } }),
      getCommit: async () => ({ data: { tree: { sha: 'b'.repeat(40) } } }),
      createBlob: async () => ({ data: { sha: 'd'.repeat(40) } }),
      createTree: async () => ({ data: { sha: 'c'.repeat(40) } }),
      createCommit: async () => ({ data: { sha: 'e'.repeat(40) } }),
      updateRef: async () => { pushAttempts++; throw Object.assign(new Error('workflow permission required'), { status: 403 }); },
    },
  });
  const service = new TaskService(github, { review: async () => { modelCalls++; return review; } }, () => port);
  const workspace = await service.createWorkspace(f.task, alice, { deviceId: 'round7-device', deviceLabel: 'Fixture' });
  await service.updateWorkspace(workspace.id, alice, { status: 'running' });
  const input = { workspaceId: workspace.id, headSha: 'a'.repeat(40), summary: 'Add a workflow', testOutput: '', files: [{ path: '.github/workflows/ci.yml', content: 'name: CI\non: push\n', encoding: 'utf-8', mode: '100644' }] };
  await assert.rejects(() => service.submitTask(f.task, alice, input, undefined, 'fixture-token'), /workflow permission/);
  let task = await service.getTask(f.task);
  assert.equal(task.status, 'submitted'); assert.equal(task.latestSubmission.status, 'reviewing');
  assert.equal(task.pendingOperation.kind, 'submit'); assert.equal(task.latestSubmission.pullRequestUrl, null);
  await assert.rejects(() => service.resumeSubmission(task.latestSubmission.id, alice, 'fixture-token'), /workflow permission/);
  await assert.rejects(() => service.removeTask(f.task, admin, 'fixture-token'), { code: 'OPERATION_IN_PROGRESS' });
  await assert.rejects(() => service.releaseTask(f.task, alice, 'fixture-token'), /只能释放/);
  await assert.rejects(() => service.requestChanges(task.latestSubmission.id, admin, 'Remove workflow', 'fixture-token'), /只能对最新/);
  await assert.rejects(() => service.submitTask(f.task, alice, { ...input, files: [{ path: 'src/a.ts', content: 'fixed', encoding: 'utf-8', mode: '100644' }] }, undefined, 'fixture-token'), /只有任务执行者/);
  task = await service.getTask(f.task);
  const reserved = (await db.query("select balance from techunter.point_accounts where owner_id=$1 and bucket='reserved'", [f.project])).rows[0].balance;
  assert.equal(Number(reserved), 100); assert.equal(pushAttempts, 2); assert.equal(modelCalls, 1);
  console.log(JSON.stringify({ observation: 'permanent-submission-failure', task: task.status, submission: task.latestSubmission.status, pending: task.pendingOperation.kind, reserved: Number(reserved), pushAttempts, modelCalls }));
});

test('expired GitHub token plus a token-service outage blocks unrelated authenticated routes', async () => {
  await db.query("insert into techunter.github_connections(user_id,credential,refresh_credential,access_expires_at,refresh_expires_at) values($1,$2,$3,now()-interval '1 minute',now()+interval '1 day')", [alice.id, encryptCredential('fixture-old-token'), encryptCredential('fixture-refresh-token')]);
  const originalFetch = globalThis.fetch;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const session = { user_id: alice.id, expires_at: new Date(Date.now() + 30 * 86400000).toISOString(), idle_expires_at: new Date(Date.now() + 7 * 86400000).toISOString() };
  let refreshCalls = 0, dashboardCalls = 0, introspectionCalls = 0;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.href === 'https://github.com/login/oauth/access_token') { refreshCalls++; return json({ error: 'fixture outage' }, 503); }
    assert.equal(url.hostname, 'database.fixture.invalid', 'All external calls must use fixtures');
    const name = url.pathname.split('/').at(-1);
    if (url.pathname.includes('/rpc/')) return json(await rpc(name, await request.json()));
    if (name === 'sessions') return json([session]);
    if (name === 'users') return json((await db.query('select * from techunter.users where id=$1', [alice.id])).rows[0]);
    if (name === 'github_connections') return json((await db.query('select * from techunter.github_connections where user_id=$1', [alice.id])).rows);
    throw new Error(`Unhandled fixture request: ${request.method} ${name}`);
  };
  const app = Fastify();
  try {
    await app.register(cookie);
    registerAuth(app, { introspect: async () => { introspectionCalls++; throw new Error('must not reach Conexus'); } });
    app.get('/api/dashboard', () => { dashboardCalls++; return { ok: true }; });
    const headers = { cookie: 'techunter_session=fixture-session' };
    const responses = [];
    for (const options of [{ url: '/api/dashboard' }, { url: '/api/auth/me' }, { method: 'POST', url: '/api/auth/conexus/refresh', payload: {} }]) {
      const response = await app.inject({ ...options, headers });
      assert.equal(response.statusCode, 502); responses.push([options.url, response.statusCode]);
    }
    assert.equal(dashboardCalls, 0); assert.equal(introspectionCalls, 0); assert.equal(refreshCalls, 3);
    // With a still-valid access token the unrelated route is available again.
    await db.query("update techunter.github_connections set access_expires_at=now()+interval '1 hour' where user_id=$1", [alice.id]);
    assert.equal((await app.inject({ url: '/api/dashboard', headers })).statusCode, 200);
    const begin = await app.inject({ method: 'POST', url: '/api/auth/github', headers });
    assert.equal(begin.statusCode, 200);
    const requestedScopes = new URL(begin.json().authorizationUrl).searchParams.get('scope').split(' ');
    assert.equal(requestedScopes.includes('workflow'), false);
    console.log(JSON.stringify({ observation: 'github-outage-coupling', responses, dashboardCalls, introspectionCalls, refreshCalls, requestedScopes }));
  } finally { await app.close(); globalThis.fetch = originalFetch; }
});

test('assistant workspace tool only queues a row; desktop has no queued-workspace consumer', async () => {
  const f = await fixture(), service = new TaskService({}, {}, () => port);
  const project = await service.getProject(f.project);
  const assistant = new AssistantService(service, {});
  // Invoke the real tool handler without a paid model call.
  const tools = assistant.taskTools({ user: alice, deviceId: 'assistant-device', deviceLabel: 'Fixture' }, project);
  const workspace = JSON.parse(await tools.find(tool => tool.definition.function.name === 'create_workspace').execute({ task_id: f.task }));
  assert.equal(workspace.status, 'queued');
  const dock = fs.readFileSync(new URL('../../apps/desktop/src/web/src/AgentDock.tsx', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../../apps/desktop/src/web/src/App.tsx', import.meta.url), 'utf8');
  assert.equal(dock.includes('.provision('), false);
  assert.equal((app.match(/\.provision\(/g) ?? []).length, 1);
  assert.equal(app.includes("status === 'queued'"), false);
  console.log(JSON.stringify({ observation: 'assistant-workspace', status: workspace.status, note: 'Only TaskDetail manual provisionWorkspace calls desktop.provision; no queue consumer found by source inspection.' }));
});
