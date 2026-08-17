import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { Role } from '../shared/contracts.js';
import { config } from './config.js';

// Keep the specifier intact when bundling: older esbuild builtin tables rewrite
// a static `node:sqlite` import to the nonexistent npm package `sqlite`.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type SqlValue = string | number | bigint | null | Uint8Array;

export class Database {
  readonly raw: DatabaseSyncType;

  constructor(filename = path.join(config.dataDir, 'techunter.sqlite')) {
    this.raw = new DatabaseSync(filename);
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.provisionMissingUserAccounts();
  }

  private migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        login TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        avatar_url TEXT,
        role TEXT NOT NULL CHECK(role IN ('admin','maintainer','member')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        repo_owner TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        default_branch TEXT NOT NULL DEFAULT 'main',
        local_repo_path TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(repo_owner, repo_name)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        parent_task_id TEXT REFERENCES tasks(id),
        root_task_id TEXT REFERENCES tasks(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        acceptance_json TEXT NOT NULL DEFAULT '[]',
        scope_json TEXT,
        status TEXT NOT NULL CHECK(status IN ('draft','open','active','submitted','accepted','cancelled')),
        reward_points INTEGER NOT NULL DEFAULT 0 CHECK(reward_points >= 0),
        publisher_id TEXT NOT NULL REFERENCES users(id),
        assignee_id TEXT REFERENCES users(id),
        reviewer_id TEXT REFERENCES users(id),
        payer_account_id TEXT,
        base_sha TEXT NOT NULL DEFAULT '',
        target_branch TEXT NOT NULL DEFAULT 'main',
        github_issue_number INTEGER,
        github_issue_url TEXT,
        lock_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, status);

      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        lease_expires_at TEXT NOT NULL,
        released_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_active_task
        ON claims(task_id) WHERE released_at IS NULL;

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        status TEXT NOT NULL CHECK(status IN ('queued','provisioning','running','stopped','failed')),
        provider TEXT NOT NULL CHECK(provider IN ('package','docker','coder')),
        package_path TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workspaces_task ON workspaces(task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        author_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL CHECK(status IN ('pending','reviewing','approved','changes_requested','rejected')),
        summary TEXT NOT NULL DEFAULT '',
        test_output TEXT NOT NULL DEFAULT '',
        files_json TEXT NOT NULL DEFAULT '[]',
        pull_request_url TEXT,
        review_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_submissions_task ON submissions(task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS point_accounts (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL CHECK(owner_type IN ('system','project','user')),
        owner_id TEXT NOT NULL,
        bucket TEXT NOT NULL CHECK(bucket IN ('available','reserved')),
        label TEXT NOT NULL,
        balance INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(owner_type, owner_id, bucket)
      );

      CREATE TABLE IF NOT EXISTS point_transfers (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK(amount > 0),
        from_account_id TEXT NOT NULL REFERENCES point_accounts(id),
        to_account_id TEXT NOT NULL REFERENCES point_accounts(id),
        task_id TEXT REFERENCES tasks(id),
        memo TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        actor_id TEXT REFERENCES users(id),
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS github_deliveries (
        delivery_id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        processed_at TEXT NOT NULL
      );
    `);
  }

  private provisionMissingUserAccounts(): void {
    const users = this.raw.prepare('SELECT id, name FROM users').all() as Array<{ id: string; name: string }>;
    for (const user of users) {
      ensureAccount(this, 'user', user.id, 'available', user.name);
      ensureAccount(this, 'user', user.id, 'reserved', `${user.name}冻结`);
    }
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  audit(actorId: string | null, action: string, entityType: string, entityId: string, payload: unknown = {}): void {
    this.raw.prepare(
      'INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), actorId, action, entityType, entityId, JSON.stringify(payload), new Date().toISOString());
  }

  close(): void {
    this.raw.close();
  }
}

export function ensureUser(
  database: Database,
  input: { login: string; name: string; avatarUrl?: string | null; role?: Role },
): string {
  const existing = database.raw.prepare('SELECT id FROM users WHERE login = ?').get(input.login) as { id: string } | undefined;
  if (existing) {
    database.raw.prepare('UPDATE users SET name = ?, avatar_url = ? WHERE id = ?')
      .run(input.name, input.avatarUrl ?? null, existing.id);
    ensureAccount(database, 'user', existing.id, 'available', input.name);
    ensureAccount(database, 'user', existing.id, 'reserved', `${input.name}冻结`);
    return existing.id;
  }
  const id = randomUUID();
  database.raw.prepare(
    'INSERT INTO users (id, login, name, avatar_url, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, input.login, input.name, input.avatarUrl ?? null, input.role ?? 'member', new Date().toISOString());
  ensureAccount(database, 'user', id, 'available', input.name);
  ensureAccount(database, 'user', id, 'reserved', `${input.name}冻结`);
  return id;
}

function ensureAccount(
  database: Database,
  ownerType: 'system' | 'project' | 'user',
  ownerId: string,
  bucket: 'available' | 'reserved',
  label: string,
): string {
  const found = database.raw.prepare(
    'SELECT id FROM point_accounts WHERE owner_type = ? AND owner_id = ? AND bucket = ?'
  ).get(ownerType, ownerId, bucket) as { id: string } | undefined;
  if (found) return found.id;
  const id = randomUUID();
  database.raw.prepare(
    'INSERT INTO point_accounts (id, owner_type, owner_id, bucket, label, balance, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
  ).run(id, ownerType, ownerId, bucket, label, new Date().toISOString());
  return id;
}

function seedTransfer(database: Database, key: string, fromId: string, toId: string, amount: number, memo: string): void {
  const found = database.raw.prepare('SELECT id FROM point_transfers WHERE idempotency_key = ?').get(key);
  if (found) return;
  database.transaction(() => {
    database.raw.prepare('UPDATE point_accounts SET balance = balance - ? WHERE id = ?').run(amount, fromId);
    database.raw.prepare('UPDATE point_accounts SET balance = balance + ? WHERE id = ?').run(amount, toId);
    database.raw.prepare(
      'INSERT INTO point_transfers (id, idempotency_key, type, amount, from_account_id, to_account_id, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), key, 'allocation', amount, fromId, toId, memo, new Date().toISOString());
  });
}

export function seedDemo(database: Database): { adminId: string; projectId: string } {
  const adminId = ensureUser(database, { login: 'hunter.admin', name: '猎人管理员', role: 'admin' });
  const developerId = ensureUser(database, { login: 'lin.dev', name: '林开发', role: 'member' });
  ensureUser(database, { login: 'zhou.review', name: '周审核', role: 'maintainer' });

  let project = database.raw.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string } | undefined;
  if (!project) {
    const id = randomUUID();
    database.raw.prepare(
      'INSERT INTO projects (id, name, description, repo_owner, repo_name, default_branch, local_repo_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      'Techunter Core',
      '企业内部任务分发与 Agent 协作平台',
      'Zhang-Dongfang',
      'Techunter',
      'main',
      config.demoRepoPath,
      new Date().toISOString(),
    );
    project = { id };
  }

  const mint = ensureAccount(database, 'system', 'mint', 'available', '系统发行');
  const projectAvailable = ensureAccount(database, 'project', project.id, 'available', 'Techunter Core 项目预算');
  const projectReserved = ensureAccount(database, 'project', project.id, 'reserved', 'Techunter Core 冻结预算');
  const adminAvailable = ensureAccount(database, 'user', adminId, 'available', '猎人管理员');
  ensureAccount(database, 'user', adminId, 'reserved', '猎人管理员冻结');
  const developerAvailable = ensureAccount(database, 'user', developerId, 'available', '林开发');
  ensureAccount(database, 'user', developerId, 'reserved', '林开发冻结');
  seedTransfer(database, `seed:project:${project.id}`, mint, projectAvailable, 10_000, '内部试点项目预算');
  seedTransfer(database, `seed:user:${adminId}`, mint, adminAvailable, 800, '内部试点个人积分');
  seedTransfer(database, `seed:user:${developerId}`, mint, developerAvailable, 320, '内部试点个人积分');

  const taskCount = database.raw.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number };
  if (taskCount.count === 0) {
    const now = new Date().toISOString();
    const samples = [
      ['优化任务认领并发控制', '保证多名开发者同时抢单时只有一人成功，并记录完整审计事件。', 'open', 120],
      ['补充提交审查的隐藏测试', '为任务提交加入服务端隐藏测试，并在交付文档中展示可公开证据。', 'open', 180],
      ['设计贡献点账单页面', '展示余额、冻结金额、收入和支出，支持按任务筛选。', 'active', 90],
    ] as const;
    for (const [title, description, status, reward] of samples) {
      const id = randomUUID();
      database.raw.prepare(`
        INSERT INTO tasks (
          id, project_id, title, description, summary, acceptance_json, status, reward_points,
          publisher_id, assignee_id, base_sha, target_branch, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'main', ?, ?)
      `).run(
        id,
        project.id,
        title,
        description,
        description,
        JSON.stringify(['交付内容符合任务描述', '相关检查和测试通过', '生成完整交付说明']),
        status,
        reward,
        adminId,
        status === 'active' ? developerId : null,
        now,
        now,
      );
    }
  }

  const unfundedDemoTasks = database.raw.prepare(`
    SELECT id, title, reward_points FROM tasks
    WHERE project_id = ? AND payer_account_id IS NULL AND status IN ('open','active')
  `).all(project.id) as Array<{ id: string; title: string; reward_points: number }>;
  for (const task of unfundedDemoTasks) {
    seedTransfer(
      database,
      `seed:task-reserve:${task.id}`,
      projectAvailable,
      projectReserved,
      task.reward_points,
      `演示任务冻结：${task.title}`,
    );
    database.raw.prepare('UPDATE tasks SET payer_account_id = ? WHERE id = ?').run(project.id, task.id);
  }

  return { adminId, projectId: project.id };
}
