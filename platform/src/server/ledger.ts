import { randomUUID } from 'node:crypto';
import type { LedgerEntry } from '../shared/contracts.js';
import { Database } from './database.js';

type OwnerType = 'system' | 'project' | 'user';
type Bucket = 'available' | 'reserved';

interface AccountRow {
  id: string;
  owner_type: OwnerType;
  owner_id: string;
  bucket: Bucket;
  label: string;
  balance: number;
}

export class LedgerService {
  constructor(private readonly database: Database) {}

  account(ownerType: OwnerType, ownerId: string, bucket: Bucket): AccountRow {
    const row = this.database.raw.prepare(
      'SELECT * FROM point_accounts WHERE owner_type = ? AND owner_id = ? AND bucket = ?'
    ).get(ownerType, ownerId, bucket) as AccountRow | undefined;
    if (!row) throw new Error(`贡献点账户不存在：${ownerType}:${ownerId}:${bucket}`);
    return row;
  }

  postInTransaction(input: {
    idempotencyKey: string;
    type: string;
    amount: number;
    fromAccountId: string;
    toAccountId: string;
    taskId?: string | null;
    memo: string;
    allowOverdraft?: boolean;
  }): string {
    if (!Number.isInteger(input.amount) || input.amount <= 0) throw new Error('贡献点数量必须是正整数。');
    const existing = this.database.raw.prepare('SELECT id FROM point_transfers WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as { id: string } | undefined;
    if (existing) return existing.id;

    const source = this.database.raw.prepare('SELECT * FROM point_accounts WHERE id = ?')
      .get(input.fromAccountId) as AccountRow | undefined;
    const destination = this.database.raw.prepare('SELECT * FROM point_accounts WHERE id = ?')
      .get(input.toAccountId) as AccountRow | undefined;
    if (!source || !destination) throw new Error('贡献点转账账户不存在。');
    if (!input.allowOverdraft && source.balance < input.amount) {
      throw new Error(`贡献点余额不足，需要 ${input.amount}，当前可用 ${source.balance}。`);
    }

    const id = randomUUID();
    this.database.raw.prepare('UPDATE point_accounts SET balance = balance - ? WHERE id = ?')
      .run(input.amount, source.id);
    this.database.raw.prepare('UPDATE point_accounts SET balance = balance + ? WHERE id = ?')
      .run(input.amount, destination.id);
    this.database.raw.prepare(`
      INSERT INTO point_transfers (
        id, idempotency_key, type, amount, from_account_id, to_account_id, task_id, memo, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.idempotencyKey,
      input.type,
      input.amount,
      source.id,
      destination.id,
      input.taskId ?? null,
      input.memo,
      new Date().toISOString(),
    );
    return id;
  }

  balance(ownerType: OwnerType, ownerId: string, bucket: Bucket = 'available'): number {
    return this.account(ownerType, ownerId, bucket).balance;
  }

  listForUser(userId: string): LedgerEntry[] {
    const rows = this.database.raw.prepare(`
      SELECT t.*, source.label AS from_label, destination.label AS to_label
      FROM point_transfers t
      JOIN point_accounts source ON source.id = t.from_account_id
      JOIN point_accounts destination ON destination.id = t.to_account_id
      WHERE source.owner_id = ? OR destination.owner_id = ?
      ORDER BY t.created_at DESC LIMIT 100
    `).all(userId, userId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row['id']),
      type: String(row['type']),
      amount: Number(row['amount']),
      fromLabel: String(row['from_label']),
      toLabel: String(row['to_label']),
      taskId: row['task_id'] ? String(row['task_id']) : null,
      memo: String(row['memo']),
      createdAt: String(row['created_at']),
    }));
  }
}
