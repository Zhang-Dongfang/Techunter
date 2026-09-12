// Regression coverage for interrupted claims, draft deletion and inherited file scopes.
// In-memory PostgreSQL, fake GitHub, and a loopback model fixture; no external calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { before, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { TaskService } from '../dist/task-service.js';
import { GitHubService } from '../dist/github-service.js';

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
before(async () => {
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const root = new URL('../../../infra/supabase/migrations/', import.meta.url);
  for (const name of fs.readdirSync(root).filter(name => name.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(new URL(name, root), 'utf8'));
  [admin, alice, bob] = (await db.query("insert into techunter.users(login,name,role,github_login) values('coord-admin','Admin','admin','admin'),('coord-alice','Alice','member','alice'),('coord-bob','Bob','member','bob') returning *")).rows.map(row => ({ ...row, githubLogin: row.github_login }));
});
after(async () => { await db.close(); });

test('denied or unavailable GitHub permission checks never reserve a task', async () => {
  for (const access of [401, 403, 404, 503, false, undefined]) {
    const f = await fixture(), github = new GitHubService();
    github.client = async () => ({ request: async () => {
      if (typeof access === 'number') throw Object.assign(new Error('GitHub unavailable'), { status: access });
      return { data: { permissions: { push: access } } };
    } });
    const service = new TaskService(github, {}, () => port);
    await assert.rejects(() => service.claimTask(f.task, alice, 'fixture-token'),
      access === 503 ? /GitHub unavailable/ : { code: 'GITHUB_WRITE_REQUIRED' });
    assert.equal((await service.getTask(f.task)).status, 'open');
    assert.equal((await db.query('select id from techunter.claims where task_id=$1', [f.task])).rows.length, 0);
    assert.equal((await service.getTask(f.task)).pendingOperation, null);
  }
});

test('concurrent authorized claims still produce one assignee and one GitHub synchronization', async () => {
  const f = await fixture(); let syncs = 0;
  const github = new GitHubService();
  github.client = async () => ({ request: async () => ({ data: { permissions: { push: true } } }) });
  github.syncClaim = async () => { syncs++; };
  const service = new TaskService(github, {}, () => port);
  const results = await Promise.allSettled([service.claimTask(f.task, alice, 'fixture-token'), service.claimTask(f.task, bob, 'fixture-token')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(syncs, 1);
  assert.equal((await db.query('select id from techunter.claims where task_id=$1', [f.task])).rows.length, 1);
});

test('a partial claim becomes a retryable release and an admin can complete it without losing the branch or budget', async () => {
  const f = await fixture(), refs = new Map(); let assignees = [], denyOwner = false, loseResponse = true;
  const github = new GitHubService();
  github.client = async credential => ({
    request: async () => ({ data: { permissions: { push: true } } }),
    git: {
      getRef: async ({ ref }) => { if (!refs.has(ref)) throw Object.assign(new Error('no branch'), { status: 404 }); return { data: { object: { sha: refs.get(ref) } } }; },
      createRef: async ({ ref, sha }) => { refs.set(ref.replace(/^refs\//, ''), sha); return { data: { object: { sha } } }; },
    },
    issues: { update: async input => {
      if (denyOwner && credential === 'alice-token') throw Object.assign(new Error('permission revoked'), { status: 403 });
      assignees = input.assignees;
      if (loseResponse) { loseResponse = false; throw new Error('lost response after remote mutation'); }
    } },
  });
  const service = new TaskService(github, {}, () => port);
  await assert.rejects(() => service.claimTask(f.task, alice, 'alice-token'), /lost response/);
  const claimed = await service.getTask(f.task);
  assert.deepEqual(assignees, ['alice']);
  const claimOperation = claimed.pendingOperation.id;
  const transfersBefore = (await db.query('select id from techunter.point_transfers where task_id=$1', [f.task])).rows;
  // Simulate saved branch work; recovery must not delete/reset the branch.
  refs.set(`heads/${claimed.workingBranch}`, 'b'.repeat(40));
  denyOwner = true;
  await assert.rejects(() => service.releaseTask(f.task, alice, 'alice-token'), /permission revoked/);
  const releasing = await service.getTask(f.task);
  assert.equal(releasing.pendingOperation.kind, 'release');
  assert.notEqual(releasing.pendingOperation.id, claimOperation);
  assert.equal(releasing.status, 'active');
  await assert.rejects(() => service.claimTask(f.task, bob, 'bob-token'), { code: 'OPERATION_IN_PROGRESS' });
  await assert.rejects(() => service.removeTask(f.task, admin, 'admin-token'), { code: 'OPERATION_IN_PROGRESS' });
  const released = await service.releaseTask(f.task, admin, 'admin-token');
  assert.equal(released.status, 'open'); assert.equal(released.assignee, null); assert.equal(released.pendingOperation, null);
  assert.deepEqual(assignees, []);
  assert.equal(refs.get(`heads/${claimed.workingBranch}`), 'b'.repeat(40));
  assert.deepEqual((await db.query('select id from techunter.point_transfers where task_id=$1', [f.task])).rows, transfersBefore);
  await service.claimTask(f.task, bob, 'bob-token');
  assert.equal((await service.getTask(f.task)).workingBranch, claimed.workingBranch);
});

test('admin claim recovery keeps the original assignee; unrelated users cannot resume or release it', async () => {
  const f = await fixture(); let targetLogin;
  await rpc('begin_task_claim', { p_task_id: f.task, p_actor_id: alice.id });
  const service = new TaskService({ async assertClaimPermission() {}, async syncClaim(_task, _project, login, credential) {
    targetLogin = login; assert.equal(credential, 'admin-token');
  } }, {}, () => port);
  await assert.rejects(() => service.claimTask(f.task, bob, 'bob-token'), { code: 'OPERATION_IN_PROGRESS' });
  await assert.rejects(() => service.releaseTask(f.task, bob, 'bob-token'), { statusCode: 403 });
  const task = await service.claimTask(f.task, admin, 'admin-token');
  assert.equal(task.assignee.id, alice.id); assert.equal(targetLogin, 'alice'); assert.equal(task.pendingOperation, null);
  await assert.rejects(() => rpc('begin_task_release', { p_task_id: f.task, p_actor_id: admin.id }), /FORBIDDEN/);
});

test('release cannot interrupt a live claim lease, and expired claim workers cannot finish after cancellation', async () => {
  const { randomUUID } = await import('node:crypto');
  const f = await fixture();
  const id = await rpc('begin_task_claim', { p_task_id: f.task, p_actor_id: alice.id }), token = randomUUID();
  await rpc('lease_task_operation', { p_id: id, p_actor_id: alice.id, p_token: token });
  await assert.rejects(() => rpc('begin_task_release', { p_task_id: f.task, p_actor_id: admin.id }), /OPERATION_IN_PROGRESS/);
  await db.query("update techunter.task_operations set lease_until=clock_timestamp()-interval '1 second' where id=$1", [id]);
  const release = await rpc('begin_task_release', { p_task_id: f.task, p_actor_id: admin.id });
  assert.notEqual(release, id);
  assert.equal(await rpc('begin_task_release', { p_task_id: f.task, p_actor_id: alice.id }), release);
  assert.equal(await rpc('lease_task_operation', { p_id: id, p_actor_id: alice.id, p_token: token }), null);
  await assert.rejects(() => rpc('finish_task_claim', { p_id: id, p_token: token }), /OPERATION_LEASE_LOST/);
  await assert.rejects(() => rpc('finish_task_release', { p_id: release, p_token: token }), /OPERATION_LEASE_LOST/);
  const releaseToken = randomUUID();
  await rpc('lease_task_operation', { p_id: release, p_actor_id: admin.id, p_token: releaseToken });
  await rpc('finish_task_release', { p_id: release, p_token: releaseToken });
  await rpc('finish_task_release', { p_id: release, p_token: releaseToken });
  assert.equal((await new TaskService({}, {}, () => port).getTask(f.task)).status, 'open');
});

async function childDraft(f) {
  return (await db.query("insert into techunter.tasks(project_id,parent_task_id,title,publisher_id,scope_json,base_sha) values($1,$2,'unused draft',$3,$4,$5) returning id",
    [f.project, f.task, alice.id, JSON.stringify(scope), 'a'.repeat(40)])).rows[0].id;
}

test('authors can discard their own child drafts and then release or submit the parent', async () => {
  for (const action of ['release', 'submit']) {
    const f = await fixture(); await rpc('claim_task', { p_task_id: f.task, p_user_id: alice.id });
    const child = await childDraft(f);
    const service = new TaskService({ async syncRelease() {}, async assertSubmissionHead() {},
      async publishSubmission(_task, _project, _files, _review, _credential, operation) { await operation.recordTree('c'.repeat(40)); return 'https://example.invalid/pull/1'; },
    }, { async review() { return { verdict: 'approved' }; } }, () => port);
    await assert.rejects(() => service.removeTask(child, bob), { statusCode: 403 });
    await assert.rejects(() => rpc('delete_task_draft', { p_task_id: child, p_actor_id: bob.id }), /FORBIDDEN/);
    await assert.rejects(() => service.releaseTask(f.task, alice), { code: 'OPEN_CHILD_TASKS' });
    assert.equal((await service.removeTask(child, alice)).disposition, 'deleted');
    assert.equal((await service.getTask(f.task)).children.length, 0);
    const event = (await db.query("select actor_id from techunter.audit_events where entity_id=$1 and action='task.draft_deleted'", [child])).rows;
    assert.equal(event[0].actor_id, alice.id);
    if (action === 'release') assert.equal((await service.releaseTask(f.task, alice)).status, 'open');
    else {
      const workspace = await service.createWorkspace(f.task, alice, { deviceId: 'fixture-device', deviceLabel: 'fixture' });
      await service.updateWorkspace(workspace.id, alice, { status: 'running' });
      const submission = await service.submitTask(f.task, alice, { workspaceId: workspace.id, headSha: 'a'.repeat(40), summary: 'done', testOutput: 'ok', files: [{ path: 'src/a.ts', content: 'done', encoding: 'utf-8' }] });
      assert.equal(submission.status, 'approved');
    }
  }
});

test('draft deletion cannot bypass pending publication or cancel published work', async () => {
  const f = await fixture(); await rpc('claim_task', { p_task_id: f.task, p_user_id: alice.id });
  const child = await childDraft(f), service = new TaskService({}, {}, () => port);
  await rpc('begin_task_publication', { p_task_id: child, p_actor_id: alice.id, p_reward: 20, p_version: 0 });
  for (const actor of [alice, admin]) await assert.rejects(() => service.removeTask(child, actor), { code: 'OPERATION_IN_PROGRESS' });
  const { randomUUID } = await import('node:crypto'); const token = randomUUID();
  await rpc('lease_task_operation', { p_id: child, p_actor_id: alice.id, p_token: token });
  await rpc('finish_task_publication', { p_id: child, p_token: token, p_issue_number: 9000 + serial, p_issue_url: 'https://example.invalid/issues/2' });
  await assert.rejects(() => service.removeTask(child, alice), { statusCode: 403 });
  for (const actor of [alice, admin]) await assert.rejects(() => rpc('delete_task_draft', { p_task_id: child, p_actor_id: actor.id }), /TASK_NOT_REMOVABLE/);
  assert.equal((await service.getTask(child)).status, 'open');
});

test('draft deletion and publication serialize; a late analysis cannot recreate a deleted draft', async () => {
  for (const publishFirst of [false, true]) {
    const f = await fixture(); await rpc('claim_task', { p_task_id: f.task, p_user_id: alice.id });
    const child = await childDraft(f);
    const publish = () => rpc('begin_task_publication', { p_task_id: child, p_actor_id: alice.id, p_reward: 10, p_version: 0 });
    const remove = () => rpc('delete_task_draft', { p_task_id: child, p_actor_id: alice.id });
    const outcomes = await Promise.allSettled(publishFirst ? [publish(), remove()] : [remove(), publish()]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    if (!publishFirst) {
      await assert.rejects(() => rpc('save_task_analysis', { p_task_id: child, p_actor_id: alice.id, p_version: 0, p_parent_scope: scope, p_analysis: {} }));
      assert.equal((await db.query('select id from techunter.tasks where id=$1', [child])).rows.length, 0);
    }
  }
});

test('recovery and draft RPCs are executable only by the service database role', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const signature of ['delete_task_draft(uuid,uuid)', 'begin_task_claim(uuid,uuid)', 'finish_task_claim(uuid,uuid)', 'begin_task_release(uuid,uuid)']) {
      assert.equal((await db.query('select has_function_privilege($1,$2,$3) as allowed', [role, `techunter.${signature}`, 'execute'])).rows[0].allowed, role === 'service_role');
    }
  }
});

test('upgrade preserves existing claim leases, branch and ledger while enabling admin recovery', async () => {
  const { randomUUID } = await import('node:crypto');
  const legacy = new PGlite();
  try {
    await legacy.exec('create role anon; create role authenticated; create role service_role;');
    const root = new URL('../../../infra/supabase/migrations/', import.meta.url), migration = '202609120005_claim_recovery_and_drafts.sql';
    for (const name of fs.readdirSync(root).filter(name => name.endsWith('.sql') && name < migration).sort()) await legacy.exec(fs.readFileSync(new URL(name, root), 'utf8'));
    const [worker, manager] = (await legacy.query("insert into techunter.users(login,name,role,github_login) values('worker','Worker','member','worker'),('manager','Manager','admin','manager') returning id")).rows.map(row => row.id);
    const project = (await legacy.query("insert into techunter.projects(github_repository_id,name,repo_owner,repo_name,clone_url,html_url) values(1,'fixture','test','fixture','https://example.invalid/repo','https://example.invalid/repo') returning id")).rows[0].id;
    await legacy.query('select techunter.allocate_project_points($1,100)', [project]);
    const task = (await legacy.query("insert into techunter.tasks(project_id,title,publisher_id,scope_json) values($1,'legacy',$2,$3) returning id", [project, manager, JSON.stringify(scope)])).rows[0].id;
    await legacy.query("select techunter.publish_task($1,$2,100,1,'https://example.invalid/issues/1')", [task, manager]);
    const operation = (await legacy.query('select techunter.begin_task_claim($1,$2) as id', [task, worker])).rows[0].id, token = randomUUID();
    await legacy.query('select techunter.lease_task_operation($1,$2,$3)', [operation, worker, token]);
    const branch = (await legacy.query('select working_branch from techunter.tasks where id=$1', [task])).rows[0].working_branch;
    const ledger = (await legacy.query('select id from techunter.point_transfers where task_id=$1', [task])).rows;
    await legacy.exec(fs.readFileSync(new URL(migration, root), 'utf8'));
    assert.equal((await legacy.query('select techunter.begin_task_claim($1,$2) as id', [task, manager])).rows[0].id, operation);
    await assert.rejects(() => legacy.query('select techunter.begin_task_release($1,$2)', [task, manager]), /OPERATION_IN_PROGRESS/);
    await legacy.query('select techunter.release_task_operation($1,$2)', [operation, token]);
    const release = (await legacy.query('select techunter.begin_task_release($1,$2) as id', [task, manager])).rows[0].id;
    await legacy.query('select techunter.lease_task_operation($1,$2,$3)', [release, manager, token]);
    await legacy.query('select techunter.finish_task_release($1,$2)', [release, token]);
    assert.deepEqual((await legacy.query('select status,assignee_id,working_branch from techunter.tasks where id=$1', [task])).rows[0], { status: 'open', assignee_id: null, working_branch: branch });
    assert.deepEqual((await legacy.query('select id from techunter.point_transfers where task_id=$1', [task])).rows, ledger);
  } finally { await legacy.close(); }
});

test('inherited file scope permits concrete new files without broadening parent permissions', async () => {
  const { analyzeTaskWithAgent } = await import('@techunter/core');
  const { createServer } = await import('node:http');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(tmpdir(), 'techunter-scope-review-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'existing.ts'), 'export const existing = 1;');
  const answer = { summary: 'Create the new module', acceptanceCriteria: ['New module exists'], suggestedPoints: 10, scope: { ...scope, editablePaths: ['src/new.ts'] } };
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { /* consume local fixture request */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 0, model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer) } }] }));
  });
  const proxyVars = ['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','ALL_PROXY','all_proxy'];
  const originalProxy = proxyVars.map(key => [key, process.env[key]]);
  proxyVars.forEach(key => { delete process.env[key]; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const input = { config: { aiAccessMode: 'direct', aiApiKey: 'fixture-key', aiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, aiModel: 'fixture' }, title: 'New module', description: 'Add src/new.ts', repository: { root, allowCommands: false } };
  try {
    const parent = await analyzeTaskWithAgent(input);
    assert.deepEqual(parent.scope.editablePaths, ['src/new.ts']);
    const analyze = (editablePatterns, extra = {}) => analyzeTaskWithAgent({ ...input, repository: {
      ...input.repository, editablePatterns, readonlyPatterns: ['src/existing.ts'], ...extra,
    } });
    assert.deepEqual((await analyze(['src/new.ts'])).scope.editablePaths, ['src/new.ts']);
    assert.deepEqual((await analyze(['src/**'])).scope.editablePaths, ['src/new.ts']);
    await assert.rejects(() => analyze(['src/existing.ts']), /没有给出有效的 editablePaths/);
    await assert.rejects(() => analyze([], { readonlyPatterns: ['src/new.ts'] }), /没有给出有效的 editablePaths/);
    await assert.rejects(() => analyze(['src/**'], { deniedPatterns: ['src/new.ts'] }), /没有给出有效的 editablePaths/);
    answer.scope.editablePaths = ['src/existing.ts', 'src/new.ts', 'src/private/new.ts', '.env', '../outside.ts', 'src/new.ts:stream'];
    assert.deepEqual((await analyze(['src/**'], { deniedPatterns: ['src/private/**'] })).scope.editablePaths.sort(), ['src/existing.ts', 'src/new.ts']);
    answer.scope.editablePaths = ['**/*'];
    assert.deepEqual((await analyze(['src/existing.ts'])).scope.editablePaths, ['src/existing.ts']);
    await assert.rejects(() => analyze([], { readonlyPatterns: ['src/existing.ts'] }), /没有给出有效的 editablePaths/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of originalProxy) { if (value !== undefined) process.env[key] = value; }
    const resolvedRoot = path.resolve(root);
    assert.ok(resolvedRoot.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolvedRoot).startsWith('techunter-scope-review-'));
    fs.rmSync(resolvedRoot, { recursive: true, force: true });
  }
});
