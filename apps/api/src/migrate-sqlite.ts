import { createRequire } from 'node:module';
import path from 'node:path';
import { database } from './database.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type Row = Record<string, any>;

function rows(db: InstanceType<typeof DatabaseSync>, table: string): Row[] {
  const found = db.prepare("select name from sqlite_master where type = 'table' and name = ?").get(table);
  return found ? db.prepare(`select * from ${table}`).all() as Row[] : [];
}

function json(value: unknown, fallback: unknown) {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function uuid(value: unknown): string | null {
  const text = String(value ?? '');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text) ? text : null;
}

async function githubRepository(owner: string, repo: string) {
  const token = process.env['GITHUB_MIGRATION_TOKEN'];
  if (!token) throw new Error('迁移项目需要 GITHUB_MIGRATION_TOKEN 来解析稳定的 GitHub repository ID。');
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' };
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { headers });
  if (!response.ok) throw new Error(`无法读取 ${owner}/${repo}: GitHub ${response.status}`);
  const data = await response.json() as { id: number; name: string; full_name: string; description?: string; clone_url: string; html_url: string; default_branch: string; visibility?: string; private: boolean };
  const ref = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(data.default_branch)}`, { headers });
  const refData = await ref.json() as { object?: { sha?: string } };
  return { ...data, headSha: refData.object?.sha ?? '' };
}

async function upsert(table: string, payload: Row[], onConflict = 'id') {
  if (!payload.length) return;
  const result = await database().from(table).upsert(payload, { onConflict });
  if (result.error) throw new Error(`${table}: ${result.error.message}`);
}

const source = path.resolve(process.argv[2] ?? process.env['TECHUNTER_SQLITE_PATH'] ?? 'apps/desktop/.data/techunter.sqlite');
const sqlite = new DatabaseSync(source, { readOnly: true });
try {
  const users = rows(sqlite, 'users');
  await upsert('users', users.map((row) => ({
    id: row['id'],
    conexus_user_id: uuid(row['conexus_user_id']),
    login: row['login'], name: row['name'], avatar_url: row['avatar_url'], email: row['email'],
    github_login: row['github_login'], role: row['role'], created_at: row['created_at'], updated_at: row['created_at'],
  })));

  const projects = rows(sqlite, 'projects');
  for (const project of projects) {
    const repo = await githubRepository(String(project['repo_owner']), String(project['repo_name']));
    await upsert('projects', [{
      id: project['id'], github_repository_id: repo.id, name: project['name'] || repo.name,
      description: project['description'] || repo.description || '', repo_owner: repo.full_name.split('/')[0], repo_name: repo.name,
      clone_url: repo.clone_url, html_url: repo.html_url, default_branch: repo.default_branch,
      visibility: repo.visibility === 'internal' ? 'internal' : repo.private ? 'private' : 'public',
      head_sha: repo.headSha, created_at: project['created_at'], updated_at: project['created_at'],
    }]);
  }

  await upsert('tasks', rows(sqlite, 'tasks').map((row) => ({
    ...row,
    acceptance_json: json(row['acceptance_json'], []),
    scope_json: json(row['scope_json'], null),
    analysis_json: json(row['analysis_json'], null),
  })));
  await upsert('claims', rows(sqlite, 'claims'));
  await upsert('submissions', rows(sqlite, 'submissions').map((row) => ({
    ...row, files_json: json(row['files_json'], []), review_json: json(row['review_json'], null),
  })));

  const accountMap = new Map<string, string>();
  for (const account of rows(sqlite, 'point_accounts')) {
    const result = await database().from('point_accounts').upsert({
      owner_type: account['owner_type'], owner_id: account['owner_id'], bucket: account['bucket'],
      label: account['label'], balance: account['balance'], created_at: account['created_at'],
    }, { onConflict: 'owner_type,owner_id,bucket' }).select('id').single();
    if (result.error) throw new Error(`point_accounts: ${result.error.message}`);
    accountMap.set(String(account['id']), String(result.data.id));
  }
  await upsert('point_transfers', rows(sqlite, 'point_transfers').map((row) => ({
    ...row,
    from_account_id: accountMap.get(String(row['from_account_id'])),
    to_account_id: accountMap.get(String(row['to_account_id'])),
  })), 'idempotency_key');
  await upsert('audit_events', rows(sqlite, 'audit_events').map((row) => ({ ...row, payload_json: json(row['payload_json'], {}) })));
  await upsert('github_deliveries', rows(sqlite, 'github_deliveries'), 'delivery_id');
  process.stdout.write(`Migrated ${users.length} users, ${projects.length} projects, and ${rows(sqlite, 'tasks').length} tasks. Sessions and machine-local workspace paths were intentionally not migrated.\n`);
} finally {
  sqlite.close();
}
