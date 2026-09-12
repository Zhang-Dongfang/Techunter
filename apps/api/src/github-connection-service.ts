import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { database, type TechunterDatabase } from './database.js';
import { encryptCredential, decryptCredential } from './credential-vault.js';
import { httpError, translateDatabaseError } from './errors.js';

type Row = Record<string, any>;
export type GitHubTokenSet = { accessToken: string; accessExpiresAt: string | null; refreshToken: string | null; refreshExpiresAt: string | null };
type Identity = { login: string; avatarUrl: string | null };
const SKEW_MS = 60_000;

/** All credential mutations share a renewable database lease across API instances. */
export class GitHubConnectionService {
  constructor(
    private readonly refresh: (refreshToken: string) => Promise<GitHubTokenSet>,
    private readonly revoke: (accessToken: string) => Promise<void>,
    private readonly db: () => TechunterDatabase = database,
  ) {}

  private async rpc(name: string, args: Record<string, unknown>): Promise<any> {
    const result = await this.db().rpc(name, args);
    if (result.error) translateDatabaseError(new Error(result.error.message));
    return result.data;
  }

  private async withLease<T>(userId: string, work: (row: Row, token: string) => Promise<T>): Promise<T> {
    const token = randomUUID(), deadline = Date.now() + 35_000;
    let row: Row | null;
    do {
      row = await this.rpc('lease_github_connection', { p_user_id: userId, p_token: token });
      if (row) break;
      if (Date.now() >= deadline) throw httpError('GitHub 授权仍在更新，请稍后重试。', 503, 'GITHUB_CONNECTION_BUSY');
      await delay(100);
    } while (true);
    let heartbeat: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (!heartbeat) heartbeat = this.rpc('renew_github_connection', { p_user_id: userId, p_token: token })
        .then(() => undefined, () => undefined).finally(() => { heartbeat = undefined; });
    }, 20_000);
    timer.unref();
    try { return await work(row, token); }
    finally {
      clearInterval(timer);
      if (heartbeat) await heartbeat;
      await this.db().rpc('release_github_connection', { p_user_id: userId, p_token: token }).then(() => undefined, () => undefined);
    }
  }

  private access(row: Row): string | undefined {
    if (row['access_expires_at'] && Date.parse(row['access_expires_at']) <= Date.now() + SKEW_MS) return undefined;
    return decryptCredential(row['credential']);
  }

  private async save(userId: string, row: Row, token: string, tokens: GitHubTokenSet, identity: Identity | null = null) {
    await this.rpc('save_github_connection', {
      p_user_id: userId, p_token: token, p_version: row['connection_version'],
      p_credentials: { credential: encryptCredential(tokens.accessToken), access_expires_at: tokens.accessExpiresAt,
        refresh_credential: tokens.refreshToken ? encryptCredential(tokens.refreshToken) : null, refresh_expires_at: tokens.refreshExpiresAt },
      p_identity: identity,
    });
  }

  async credential(userId: string, snapshot: Row | null): Promise<string | undefined> {
    if (!snapshot?.['credential']) return undefined;
    const current = this.access(snapshot);
    if (current) return current;
    return this.withLease(userId, (row, token) => this.credentialUnderLease(userId, row, token));
  }

  private async credentialUnderLease(userId: string, row: Row, token: string): Promise<string | undefined> {
    // Another process may already have refreshed, disconnected, or rebound it.
    const access = this.access(row);
    if (access) return access;
    const refresh = decryptCredential(row['refresh_credential']);
    if (!refresh || !row['refresh_expires_at'] || Date.parse(row['refresh_expires_at']) <= Date.now() + SKEW_MS) return undefined;
    let tokens: GitHubTokenSet;
    try { tokens = await this.refresh(refresh); }
    catch (error) {
      if ((error as { code?: string }).code === 'GITHUB_AUTHORIZATION_FAILED') return undefined;
      throw error; // A transport error is not a disconnected account.
    }
    await this.save(userId, row, token, tokens);
    return tokens.accessToken;
  }

  async version(userId: string): Promise<string> {
    return this.withLease(userId, async row => String(row['connection_version']));
  }

  async connect(userId: string, expectedVersion: string, authorize: () => Promise<{ tokens: GitHubTokenSet; identity: Identity }>): Promise<void> {
    await this.withLease(userId, async (row, token) => {
      if (row['connection_version'] !== expectedVersion) throw httpError('GitHub 连接状态已变化，请重新发起授权。', 409, 'GITHUB_CONNECTION_CHANGED');
      const { tokens, identity } = await authorize();
      await this.save(userId, row, token, tokens, identity);
    });
  }

  async disconnect(userId: string): Promise<void> {
    await this.withLease(userId, async (row, token) => {
      // Wait for any in-flight rotation and revoke its saved, current token.
      const access = await this.credentialUnderLease(userId, row, token) ?? decryptCredential(row['credential']);
      if (access) await this.revoke(access);
      await this.rpc('disconnect_github_connection', { p_user_id: userId, p_token: token, p_version: row['connection_version'] });
    });
  }
}
