import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { DeliveryReview, Project, Submission, Task, TaskScope, User } from '@techunter/core';
import type { AgentService } from './agent-service.js';
import type { GitHubService } from './github-service.js';
import type { TechunterDatabase } from './database.js';
import { TaskService } from './task-service.js';

type Row = Record<string, any>;
const db = new PGlite();
const scope: TaskScope = { revision: 1, editablePaths: ['src/a.ts'], readonlyPaths: [], deniedPaths: [], visibleTests: [],
  environment: { setupCommands: [], testCommands: [], networkAllowlist: [] } };
const review: DeliveryReview = { score: 100, verdict: 'approved', summary: 'approved', findings: [{ criterion: 'works', passed: true, evidence: 'fixture' }], risks: [], deliveryDocument: 'fixture' };
const input = { summary: 'fixture delivery', testOutput: 'passed', headSha: 'frozen-sha', files: [{ path: 'src/a.ts', content: 'changed', encoding: 'utf-8' as const }] };
let worker: User, reviewer: User, repositoryId = 0;

before(async () => {
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const root = path.resolve(process.cwd(), '../../infra/supabase/migrations');
  for (const file of fs.readdirSync(root).filter(file => file.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(root, file), 'utf8'));
  const rows = (await db.query<Row>("insert into techunter.users(login, name, role, github_login) values ('worker', 'Worker', 'member', 'worker'), ('reviewer', 'Reviewer', 'admin', 'reviewer') returning *")).rows;
  [worker, reviewer] = rows.map(row => ({ ...row, githubLogin: row['github_login'] })) as User[];
});
after(async () => { await db.close(); });

async function rpc(name: string, args: Record<string, unknown>) {
  assert.match(name, /^[a-z_]+$/);
  const entries = Object.entries(args);
  for (const [key] of entries) assert.match(key, /^p_[a-z_]+$/);
  return (await db.query<Row>(`select techunter.${name}(${entries.map(([key], i) => `${key} => $${i + 1}`).join(', ')}) as result`,
    entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value))).rows[0]!['result'];
}

async function fixture() {
  const projectId = (await db.query<Row>("insert into techunter.projects(github_repository_id,name,repo_owner,repo_name,clone_url,html_url) values ($1,'fixture','test',$2,'https://example.invalid/repo.git','https://example.invalid/repo') returning id", [++repositoryId, `fixture-${repositoryId}`])).rows[0]!['id'] as string;
  await rpc('allocate_project_points', { p_project_id: projectId, p_amount: 1000 });
  let modelFailure = false, publishFailure = false, changesFailure = false, settlementFailure = false, releaseFailure = false;
  let mergeCount = 0, changeCount = 0;
  const merged = new Set<string>();
  const port = {
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === 'accept_task' && settlementFailure) return { data: null, error: { message: 'database temporarily unavailable' } };
      try { return { data: await rpc(name, args), error: null }; }
      catch (error) { return { data: null, error: { message: (error as Error).message } }; }
    },
    from(table: string) {
      if (table === 'submissions') {
        let id: string;
        const builder = { select() { return builder; }, eq(_column: string, value: string) { id = value; return builder; },
          async single() { return { data: (await db.query<Row>('select files_json from techunter.submissions where id=$1', [id])).rows[0], error: null }; } };
        return builder;
      }
      if (table === 'audit_events') return { async insert(row: Row) {
        await db.query('insert into techunter.audit_events(actor_id,action,entity_type,entity_id,payload_json) values ($1,$2,$3,$4,$5)', [row['actor_id'], row['action'], row['entity_type'], row['entity_id'], JSON.stringify(row['payload_json'])]);
        return { error: null };
      } };
      assert.equal(table, 'tasks');
      let parentId = '';
      const builder = {
        select() { return builder; },
        eq(column: string, value: string) { assert.equal(column, 'parent_task_id'); parentId = value; return builder; },
        async not() { return { data: (await db.query("select id from techunter.tasks where parent_task_id=$1 and status not in ('accepted','cancelled')", [parentId])).rows, error: null }; },
      };
      return builder;
    },
  } as unknown as TechunterDatabase;
  const github = {
    async assertSubmissionHead() {},
    async submissionTree(...args: Parameters<GitHubService['submissionTree']>) {
      assert.ok(args[2].length > 0); assert.ok(args[2].every(file => file.mode === '100644'));
      return 'c'.repeat(40);
    },
    async publishSubmission(...args: Parameters<GitHubService['publishSubmission']>) {
      if (publishFailure) throw new Error('GitHub unavailable');
      await args[5]?.recordTree?.('c'.repeat(40));
      return 'https://example.invalid/pull/1';
    },
    async completeTask(...args: Parameters<GitHubService['completeTask']>) {
      assert.equal(args[4]?.treeSha, 'c'.repeat(40));
      await args[4]?.beforeMerge();
      const task = args[0]; if (!merged.has(task.id)) { merged.add(task.id); mergeCount++; }
    },
    async syncChangesNeeded() { changeCount++; if (changesFailure) throw new Error('GitHub unavailable'); },
    async syncRelease() { if (releaseFailure) throw new Error('GitHub unavailable'); },
  } as unknown as GitHubService;
  const agent = { async review() { if (modelFailure) throw new Error('model timeout / invalid JSON'); return review; } } as unknown as AgentService;
  class FixtureService extends TaskService {
    override async getProject() { return { id: projectId, repoOwner: 'test', repoName: 'fixture' } as Project; }
    override async getSubmission(id: string) {
      const row = (await db.query<Row>('select * from techunter.submissions where id=$1', [id])).rows[0]!;
      return { id, taskId: row['task_id'], status: row['status'], author: worker, pullRequestUrl: row['pull_request_url'], review: row['review_json'], reviewedTreeSha: row['reviewed_tree_sha'] } as Submission;
    }
    override async getTask(id: string) {
      const row = (await db.query<Row>('select * from techunter.tasks where id=$1', [id])).rows[0]!;
      const latest = (await db.query<Row>('select id from techunter.submissions where task_id=$1 order by created_at desc, id desc limit 1', [id])).rows[0];
      return { ...row, id, version: row['lock_version'], projectId, title: row['title'], status: row['status'], baseSha: row['base_sha'], targetBranch: row['target_branch'],
        scope: row['scope_json'], parentTaskId: row['parent_task_id'], rewardPoints: Number(row['reward_points']), publisher: reviewer,
        assignee: row['assignee_id'] ? worker : null, acceptanceCriteria: [], workspace: { status: 'running' }, latestSubmission: latest ? await this.getSubmission(latest['id']) : null } as unknown as Task;
    }
  }
  const service = new FixtureService(github, agent, () => port);
  async function createTask(reward = 100, parentId: string | null = null): Promise<string> {
    const id = (await db.query<Row>('insert into techunter.tasks(project_id,title,publisher_id,parent_task_id,scope_json,base_sha) values ($1,$2,$3,$4,$5,$6) returning id', [projectId, `Reward ${reward}`, reviewer.id, parentId, JSON.stringify(scope), 'frozen-sha'])).rows[0]!['id'];
    await rpc('publish_task', { p_task_id: id, p_actor_id: reviewer.id, p_reward: reward, p_issue_number: 1, p_issue_url: 'https://example.invalid/issue/1' });
    await rpc('claim_task', { p_task_id: id, p_user_id: worker.id });
    await db.query("insert into techunter.workspaces(task_id,user_id,status,device_id) values ($1,$2,'running','fixture-device')", [id, worker.id]);
    return id;
  }
  const submit = (id: string) => service.submitTask(id, worker, input);
  const accept = async (id: string) => service.acceptSubmission((await submit(id)).id, reviewer);
  const reserved = async () => Number((await db.query<Row>("select balance from techunter.point_accounts where owner_type='project' and owner_id=$1 and bucket='reserved'", [projectId])).rows[0]!['balance']);
  return { projectId, service, createTask, submit, accept, reserved,
    setModelFailure: (value: boolean) => { modelFailure = value; }, setPublishFailure: (value: boolean) => { publishFailure = value; },
    setChangesFailure: (value: boolean) => { changesFailure = value; }, setSettlementFailure: (value: boolean) => { settlementFailure = value; },
    setReleaseFailure: (value: boolean) => { releaseFailure = value; },
    mergeCount: () => mergeCount, changeCount: () => changeCount };
}

test('model failure leaves no pending submission and delivery can be retried', async () => {
  const value = await fixture(), id = await value.createTask();
  value.setModelFailure(true);
  await assert.rejects(() => value.submit(id), /model timeout/);
  const task = await value.service.getTask(id);
  assert.equal(task.status, 'active');
  assert.equal(task.latestSubmission, null);
  value.setModelFailure(false);
  assert.equal((await value.submit(id)).status, 'approved');
});

test('failed release keeps the claim reserved and resumes after restart before allowing a new claim', async () => {
  const value = await fixture(), id = await value.createTask();
  value.setReleaseFailure(true);
  await assert.rejects(() => value.service.releaseTask(id, worker), /GitHub unavailable/);
  assert.equal((await value.service.getTask(id)).status, 'active');
  await assert.rejects(() => rpc('claim_task', { p_task_id: id, p_user_id: reviewer.id }), /TASK_ALREADY_CLAIMED/);
  await assert.rejects(() => value.submit(id), /仍在处理|状态或执行者/);
  const pending = (await db.query<Row>("select * from techunter.task_operations where task_id=$1 and kind='release'", [id])).rows[0]!;
  assert.equal(pending['completed_at'], null);
  assert.equal(pending['lease_token'], null);
  value.setReleaseFailure(false);
  assert.equal((await value.service.releaseTask(id, worker)).status, 'open');
  assert.equal((await db.query("select id from techunter.workspaces where task_id=$1 and status<>'stopped'", [id])).rows.length, 0);
  await rpc('claim_task', { p_task_id: id, p_user_id: reviewer.id });
  assert.equal((await db.query("select id from techunter.task_operations where task_id=$1 and kind='release'", [id])).rows.length, 1);
});

test('GitHub failure preserves the package for recovery without another model call', async () => {
  const value = await fixture(), id = await value.createTask();
  value.setPublishFailure(true);
  await assert.rejects(() => value.submit(id), /GitHub unavailable/);
  const task = await value.service.getTask(id);
  assert.equal(task.status, 'submitted');
  assert.equal(task.latestSubmission?.status, 'reviewing');
  value.setPublishFailure(false);
  value.setModelFailure(true);
  await value.service.resumeSubmission(task.latestSubmission!.id, worker);
  await assert.rejects(() => rpc('finish_submission', { p_submission_id: task.latestSubmission!.id, p_succeeded: false, p_pull_url: null }), /SUBMISSION_STATE_CONFLICT/);
  assert.equal((await value.service.getTask(id)).status, 'submitted');
});

test('legacy approved deliveries reconstruct their saved snapshot before acceptance', async () => {
  const value = await fixture(), id = await value.createTask();
  const submission = await value.submit(id);
  await db.query('update techunter.submissions set reviewed_tree_sha=null where id=$1', [submission.id]);
  assert.equal((await value.service.acceptSubmission(submission.id, reviewer)).status, 'accepted');
  assert.equal(value.mergeCount(), 1);
});

test('concurrent delivery attempts create only one active submission', async () => {
  const value = await fixture(), id = await value.createTask();
  const attempts = await Promise.allSettled([value.submit(id), value.submit(id)]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await db.query('select id from techunter.submissions where task_id=$1', [id])).rows.length, 1);
});

test('a merged task resumes settlement and retries cannot pay twice or switch review decisions', async () => {
  const value = await fixture(), id = await value.createTask();
  const submission = await value.submit(id);
  value.setSettlementFailure(true);
  await assert.rejects(() => value.service.acceptSubmission(submission.id, reviewer), /database temporarily/);
  await assert.rejects(() => value.service.requestChanges(submission.id, reviewer, 'change it'), /已有审核操作/);
  assert.equal(value.changeCount(), 0);
  value.setSettlementFailure(false);
  await value.service.acceptSubmission(submission.id, reviewer);
  await value.service.acceptSubmission(submission.id, reviewer);
  assert.equal(value.mergeCount(), 1);
  assert.equal((await value.service.getTask(id)).status, 'accepted');
  assert.equal((await db.query("select id from techunter.point_transfers where task_id=$1 and type='task_settlement'", [id])).rows.length, 1);
});

test('changes requests reject completed, cancelled, stale and self-reviewed submissions', async () => {
  const value = await fixture(), id = await value.createTask();
  const old = await value.submit(id);
  await assert.rejects(() => value.service.requestChanges(old.id, worker, 'change it'), /自己的/);
  value.setChangesFailure(true);
  await assert.rejects(() => value.service.requestChanges(old.id, reviewer, 'change it'), /GitHub unavailable/);
  await assert.rejects(() => value.service.acceptSubmission(old.id, reviewer), /已有审核操作/);
  value.setChangesFailure(false);
  await value.service.requestChanges(old.id, reviewer, 'change it');
  const latest = await value.submit(id);
  await assert.rejects(() => value.service.requestChanges(old.id, reviewer, 'stale'), /最新/);
  await assert.rejects(() => rpc('request_submission_changes', { p_submission_id: old.id, p_reviewer_id: reviewer.id, p_reason: 'stale' }), /SUBMISSION_STATE_CONFLICT/);
  await value.service.acceptSubmission(latest.id, reviewer);
  await assert.rejects(() => value.service.requestChanges(latest.id, reviewer, 'completed'), /最新/);
  await assert.rejects(() => rpc('start_submission_review', { p_submission_id: latest.id, p_reviewer_id: reviewer.id, p_action: 'request_changes' }), /SUBMISSION_STATE_CONFLICT/);
  const cancelledId = await value.createTask(), cancelled = await value.submit(cancelledId);
  await rpc('admin_remove_task', { p_task_id: cancelledId, p_actor_id: reviewer.id });
  await assert.rejects(() => value.service.requestChanges(cancelled.id, reviewer, 'cancelled'), /最新/);
  assert.equal((await value.service.getTask(cancelledId)).status, 'cancelled');
});

test('three task levels pay exactly the root budget and preserve unrelated reservations', async () => {
  const value = await fixture(), root = await value.createTask(100);
  const child = await value.createTask(60, root), grandchild = await value.createTask(20, child);
  await value.createTask(100);
  await value.accept(grandchild); await value.accept(child); await value.accept(root);
  const payouts = (await db.query<Row>("select amount from techunter.point_transfers where task_id in ($1,$2,$3) and type='task_settlement' order by amount", [root, child, grandchild])).rows;
  assert.deepEqual(payouts.map(row => Number(row['amount'])), [20, 40, 40]);
  assert.equal(await value.reserved(), 100);
});

test('cancelled subtrees retain spent descendant budget during new publication, payout and refund', async () => {
  for (const cancelRoot of [false, true]) {
    const value = await fixture(), root = await value.createTask(100);
    const child = await value.createTask(60, root), grandchild = await value.createTask(20, child);
    await value.createTask(100);
    await value.accept(grandchild);
    await rpc('admin_remove_task', { p_task_id: child, p_actor_id: reviewer.id });
    await assert.rejects(() => value.createTask(90, root), /PARENT_BUDGET_EXCEEDED/);
    // The failed publication leaves only an unfunded draft; remove it before completing the parent.
    const draft = (await db.query<Row>("select id from techunter.tasks where parent_task_id=$1 and status='draft'", [root])).rows[0]!;
    await rpc('admin_remove_task', { p_task_id: draft['id'], p_actor_id: reviewer.id });
    if (cancelRoot) await rpc('admin_remove_task', { p_task_id: root, p_actor_id: reviewer.id });
    else await value.accept(root);
    const transfer = (await db.query<Row>("select amount from techunter.point_transfers where task_id=$1 and type=$2", [root, cancelRoot ? 'task_refund' : 'task_settlement'])).rows[0]!;
    assert.equal(Number(transfer['amount']), 80);
    assert.equal(await value.reserved(), 100);
  }
});

test('new submission and review functions are not executable by browser roles', async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const signature of ['begin_submission(uuid,uuid,jsonb,text,text,jsonb,jsonb)', 'finish_submission(uuid,boolean,text)', 'start_submission_review(uuid,uuid,text)', 'request_submission_changes(uuid,uuid,text)']) {
      const row = (await db.query<Row>('select has_function_privilege($1,$2,$3) as allowed', [role, `techunter.${signature}`, 'EXECUTE'])).rows[0]!;
      assert.equal(row['allowed'], false);
    }
  }
});
