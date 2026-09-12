import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@techunter/core';
import { config } from './config.js';
import { ConexusAccountService, type ConexusAuthorization } from './conexus-account-service.js';
import { decryptCredential, encryptCredential } from './credential-vault.js';
import { database, dataOrThrow } from './database.js';
import { httpError } from './errors.js';
import { issueGitHubOAuthState, verifyGitHubOAuthState } from './github-oauth-state.js';
import { GitHubConnectionService, type GitHubTokenSet } from './github-connection-service.js';

export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60_000;
export const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60_000;
const SESSION_IDLE_TOUCH_THRESHOLD_MS = 6 * 24 * 60 * 60_000;

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: User;
    conexusUserId?: string;
    modelAuthorization?: { credential: string; audience: string };
    modelAuthorizationExpiresAt?: string;
    githubCredential?: string;
    githubConnected: boolean;
    sessionTokenHash?: string;
    sessionExpiresAt?: string;
    sessionIdleExpiresAt?: string;
  }
}

type Row = Record<string, any>;

type SessionContext = {
  row: Row;
  user: User;
  conexusUserId: string;
  githubConnection: Row | null;
};


function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function mapUser(row: Row): User {
  return {
    id: String(row['id']),
    login: String(row['login']),
    name: String(row['name']),
    avatarUrl: row['avatar_url'] ? String(row['avatar_url']) : null,
    email: row['email'] ? String(row['email']) : null,
    githubLogin: row['github_login'] ? String(row['github_login']) : null,
    role: row['role'] as User['role'],
  };
}

export function sessionDeadlines(now = Date.now()): { expiresAt: string; idleExpiresAt: string } {
  return {
    expiresAt: new Date(now + SESSION_ABSOLUTE_TTL_MS).toISOString(),
    idleExpiresAt: new Date(now + SESSION_IDLE_TTL_MS).toISOString(),
  };
}

export function shouldTouchSession(idleExpiresAt: string, now = Date.now()): boolean {
  const expiry = Date.parse(idleExpiresAt);
  return Number.isFinite(expiry) && expiry - now <= SESSION_IDLE_TOUCH_THRESHOLD_MS;
}

async function sessionByTokenHash(tokenHash: string): Promise<SessionContext | null> {
  const now = new Date().toISOString();
  const result = await database().from('sessions').select('*')
    .eq('token_hash', tokenHash)
    .gt('expires_at', now)
    .gt('idle_expires_at', now)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) return null;
  const [userResult, githubResult] = await Promise.all([
    database().from('users').select('*').eq('id', result.data.user_id).single(),
    database().from('github_connections').select('*').eq('user_id', result.data.user_id).maybeSingle(),
  ]);
  if (userResult.error) throw new Error(userResult.error.message);
  if (githubResult.error) throw new Error(githubResult.error.message);
  const conexusUserId = userResult.data.conexus_user_id ? String(userResult.data.conexus_user_id) : '';
  if (!conexusUserId) return null;
  return {
    row: { ...result.data, token_hash: tokenHash },
    user: mapUser(userResult.data as Row),
    conexusUserId,
    githubConnection: githubResult.data as Row | null,
  };
}

async function session(token: string | undefined): Promise<SessionContext | null> {
  return token ? sessionByTokenHash(hashToken(token)) : null;
}

async function touchSession(row: Row, now = Date.now()): Promise<Row> {
  const idleExpiresAt = String(row['idle_expires_at'] ?? '');
  if (!shouldTouchSession(idleExpiresAt, now)) return row;
  const absoluteExpiry = Date.parse(String(row['expires_at'] ?? ''));
  if (!Number.isFinite(absoluteExpiry) || absoluteExpiry <= now) return row;
  const nextIdleExpiry = new Date(Math.min(absoluteExpiry, now + SESSION_IDLE_TTL_MS)).toISOString();
  const result = await database().from('sessions')
    .update({ idle_expires_at: nextIdleExpiry })
    .eq('token_hash', row['token_hash']);
  if (result.error) throw new Error(result.error.message);
  return { ...row, idle_expires_at: nextIdleExpiry };
}

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: string): void {
  const value = config();
  const secure = value.publicUrl.startsWith('https://');
  reply.setCookie('techunter_session', token, {
    httpOnly: true,
    sameSite: secure ? 'none' : 'lax',
    secure,
    path: '/',
    maxAge: Math.max(1, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)),
  });
}

function allowedAudience(value: string): boolean {
  try {
    const origin = new URL(value).origin;
    return [config().publicUrl, ...config().webOrigins].some((candidate) => new URL(candidate).origin === origin);
  } catch {
    return false;
  }
}

function githubAuthorizationCompletePage(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub 已连接</title><style>body{min-height:100vh;margin:0;display:grid;place-items:center;background:#0b0d10;color:#f5f7fa;font:14px system-ui}.card{max-width:420px;padding:32px;border:1px solid #30343b;border-radius:16px;background:#17191d;text-align:center}h1{font-size:20px}p{color:#aeb4bf;line-height:1.6}</style></head><body><main class="card"><h1>GitHub 已连接</h1><p>可以关闭这个页面并返回 Techunter。</p></main></body></html>`;
}

async function ensureUser(authorization: ConexusAuthorization): Promise<User> {
  const result = await database().rpc('upsert_conexus_user', {
    p_id: authorization.user.id, p_email: authorization.user.email,
    p_name: authorization.user.name, p_admin: authorization.user.role === 'admin',
  });
  if (result.error) throw new Error(result.error.message);
  return mapUser(result.data as Row);
}

function authorizationInput(body: unknown): { runTicket: string; audience: string } {
  const input = body as { runTicket?: unknown; audience?: unknown } | null;
  const runTicket = typeof input?.runTicket === 'string' ? input.runTicket : '';
  const audience = typeof input?.audience === 'string' ? input.audience : '';
  if (!runTicket.startsWith('cnx_run_v1.') || runTicket.length > 8 * 1024 || !allowedAudience(audience)) {
    throw httpError('Conexus 授权参数无效。', 400, 'INVALID_AUTHORIZATION');
  }
  return { runTicket, audience: new URL(audience).origin };
}

function secondsDeadline(value: unknown, now = Date.now()): string | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(now + seconds * 1_000).toISOString() : null;
}

async function requestGitHubToken(body: Record<string, string>): Promise<GitHubTokenSet> {
  const github = config().github;
  const response = await fetch('https://github.com/login/oauth/access_token', {
    signal: AbortSignal.timeout(20_000),
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: github.clientId, client_secret: github.clientSecret, ...body }),
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (response.status >= 500) throw httpError('GitHub 授权服务暂时不可用，请稍后重试。', 502, 'GITHUB_AUTHORIZATION_UNAVAILABLE');
  if (!response.ok || !payload || typeof payload['access_token'] !== 'string') {
    throw httpError(String(payload?.['error_description'] ?? 'GitHub 登录失败。'), 401, 'GITHUB_AUTHORIZATION_FAILED');
  }
  return {
    accessToken: payload['access_token'],
    accessExpiresAt: secondsDeadline(payload['expires_in']),
    refreshToken: typeof payload['refresh_token'] === 'string' ? payload['refresh_token'] : null,
    refreshExpiresAt: secondsDeadline(payload['refresh_token_expires_in']),
  };
}

async function revokeGitHubAuthorization(accessToken: string): Promise<void> {
  const github = config().github;
  const response = await fetch(`https://api.github.com/applications/${encodeURIComponent(github.clientId)}/grant`, {
    signal: AbortSignal.timeout(20_000),
    method: 'DELETE',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Basic ${Buffer.from(`${github.clientId}:${github.clientSecret}`).toString('base64')}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ access_token: accessToken }),
  });
  if (!response.ok && response.status !== 404 && response.status !== 422) {
    throw httpError('GitHub 暂时无法撤销授权，请稍后重试。', 502, 'GITHUB_DISCONNECT_FAILED');
  }
}

async function audit(actorId: string, action: string, payload: Record<string, unknown> = {}): Promise<void> {
  const result = await database().from('audit_events').insert({
    actor_id: actorId,
    action,
    entity_type: 'user',
    entity_id: actorId,
    payload_json: payload,
  });
  if (result.error) throw new Error(result.error.message);
}

export function registerAuth(app: FastifyInstance, conexus = new ConexusAccountService()): void {
  const connections = new GitHubConnectionService(
    refreshToken => requestGitHubToken({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    revokeGitHubAuthorization,
  );
  app.decorateRequest('currentUser');
  app.decorateRequest('conexusUserId');
  app.decorateRequest('modelAuthorization');
  app.decorateRequest('modelAuthorizationExpiresAt');
  app.decorateRequest('githubCredential');
  app.decorateRequest('githubConnected', false);
  app.decorateRequest('sessionTokenHash');
  app.decorateRequest('sessionExpiresAt');
  app.decorateRequest('sessionIdleExpiresAt');

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const path = request.url.split('?')[0];
    const isPublic =
      path === '/api/auth/conexus/config' ||
      path === '/api/auth/conexus' ||
      path === '/api/auth/github/callback' ||
      path === '/api/auth/logout' ||
      path === '/api/github/webhook';
    if (isPublic) return;
    const current = await session(request.cookies['techunter_session']);
    if (!current) return reply.code(401).send({ error: '请先登录 Techunter。', code: 'UNAUTHENTICATED' });
    current.row = await touchSession(current.row);
    request.currentUser = current.user;
    request.conexusUserId = current.conexusUserId;
    request.sessionTokenHash = String(current.row['token_hash']);
    request.sessionExpiresAt = String(current.row['expires_at']);
    request.sessionIdleExpiresAt = String(current.row['idle_expires_at']);
    const modelExpiresAt = current.row['model_credential_expires_at'] ? String(current.row['model_credential_expires_at']) : undefined;
    if (modelExpiresAt) request.modelAuthorizationExpiresAt = modelExpiresAt;
    if (modelExpiresAt && Date.parse(modelExpiresAt) > Date.now()) {
      const modelCredential = decryptCredential(current.row['model_credential']);
      const modelAudience = current.row['model_audience'] ? String(current.row['model_audience']) : undefined;
      if (modelCredential && modelAudience) request.modelAuthorization = { credential: modelCredential, audience: modelAudience };
    }
    if (!(path === '/api/auth/github' && request.method === 'DELETE')) {
      request.githubCredential = await connections.credential(current.user.id, current.githubConnection);
    }
    request.githubConnected = Boolean(request.githubCredential);
  });

  app.get('/api/auth/conexus/config', async () => ({
    apiUrl: config().conexus.apiUrl,
    publicationSlug: config().conexus.publicationSlug,
    displayName: 'Techunter',
  }));

  app.post('/api/auth/conexus', async (request, reply) => {
    const input = authorizationInput(request.body);
    const authorization = await conexus.introspect(input.runTicket, input.audience);
    const user = await ensureUser(authorization);
    const token = randomBytes(32).toString('base64url');
    const deadlines = sessionDeadlines();
    const insert = await database().from('sessions').insert({
      token_hash: hashToken(token),
      user_id: user.id,
      model_credential: encryptCredential(input.runTicket),
      model_audience: authorization.audience,
      model_credential_expires_at: authorization.expiresAt,
      expires_at: deadlines.expiresAt,
      idle_expires_at: deadlines.idleExpiresAt,
    });
    if (insert.error) throw new Error(insert.error.message);
    setSessionCookie(reply, token, deadlines.expiresAt);
    await audit(user.id, 'auth.conexus_login', {
      audience: authorization.audience,
      ticketFingerprint: hashToken(input.runTicket).slice(0, 12),
      modelAuthorizationExpiresAt: authorization.expiresAt,
      sessionExpiresAt: deadlines.expiresAt,
    });
    return {
      user,
      session: deadlines,
      modelAuthorizationExpiresAt: authorization.expiresAt,
    };
  });

  app.post('/api/auth/conexus/refresh', async (request) => {
    const input = authorizationInput(request.body);
    const authorization = await conexus.introspect(input.runTicket, input.audience);
    if (authorization.user.id !== request.conexusUserId) {
      throw httpError('浏览器中的 Conexus 账号与当前 Techunter 用户不一致。', 409, 'CONEXUS_ACCOUNT_MISMATCH');
    }
    const user = await ensureUser(authorization);
    const update = await database().from('sessions').update({
      model_credential: encryptCredential(input.runTicket),
      model_audience: authorization.audience,
      model_credential_expires_at: authorization.expiresAt,
    }).eq('token_hash', request.sessionTokenHash);
    if (update.error) throw new Error(update.error.message);
    await audit(user.id, 'auth.conexus_authorization_refreshed', {
      audience: authorization.audience,
      ticketFingerprint: hashToken(input.runTicket).slice(0, 12),
      modelAuthorizationExpiresAt: authorization.expiresAt,
    });
    return { user, modelAuthorizationExpiresAt: authorization.expiresAt };
  });

  app.get('/api/auth/me', async (request) => ({
    user: request.currentUser,
    githubConnected: request.githubConnected,
    modelAuthorizationExpiresAt: request.modelAuthorizationExpiresAt ?? null,
    session: {
      expiresAt: request.sessionExpiresAt,
      idleExpiresAt: request.sessionIdleExpiresAt,
    },
  }));

  app.post('/api/auth/github', async (request) => {
    const github = config().github;
    if (!github.clientId || !github.clientSecret) throw httpError('未配置 GitHub OAuth。', 503);
    if (!request.sessionTokenHash) throw httpError('请先登录 Conexus，再连接 GitHub。', 401);
    const state = issueGitHubOAuthState(request.sessionTokenHash, config().credentialEncryptionKey, Date.now(), await connections.version(request.currentUser.id));
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', github.clientId);
    url.searchParams.set('redirect_uri', `${config().publicUrl}/api/auth/github/callback`);
    url.searchParams.set('scope', 'repo read:user read:org');
    url.searchParams.set('state', state);
    return { authorizationUrl: url.toString() };
  });

  app.get('/api/auth/github/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string; error_description?: string };
    if (query.error) throw httpError(query.error_description || 'GitHub 授权已取消。', 400);
    if (!query.code || !query.state) throw httpError('GitHub 登录状态校验失败。', 400);
    let sessionTokenHash = '';
    let connectionVersion = '';
    try {
      const claims = verifyGitHubOAuthState(query.state, config().credentialEncryptionKey);
      sessionTokenHash = claims.sessionTokenHash;
      connectionVersion = claims.connectionVersion ?? '';
      if (!connectionVersion) throw new Error('请重新发起 GitHub 授权。');
    } catch (error) {
      throw httpError((error as Error).message, 400);
    }
    const current = await sessionByTokenHash(sessionTokenHash);
    if (!current) throw httpError('Techunter 登录已失效，请重新登录 Conexus。', 401);
    await connections.connect(current.user.id, connectionVersion, async () => {
      const tokens = await requestGitHubToken({ code: query.code! });
      const headers = { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/vnd.github+json' };
      const userResponse = await fetch('https://api.github.com/user', { headers, signal: AbortSignal.timeout(20_000) });
      if (!userResponse.ok) throw httpError('无法核对 GitHub 账号，请重新授权。', 502);
      const githubUser = await userResponse.json() as { login: string; avatar_url?: string };
      if (!githubUser.login) throw httpError('GitHub 返回的账号无效。', 502);
      const github = config().github;
      if (github.allowedOrg) {
        const orgs = await (await fetch('https://api.github.com/user/orgs?per_page=100', { headers, signal: AbortSignal.timeout(20_000) })).json() as Array<{ login: string }>;
        if (!orgs.some((org) => org.login.toLowerCase() === github.allowedOrg.toLowerCase())) throw httpError(`仅允许 ${github.allowedOrg} 企业成员连接。`, 403);
      }
      const duplicate = await database().from('users').select('id').eq('github_login', githubUser.login).neq('id', current.user.id).maybeSingle();
      if (duplicate.error) throw new Error(duplicate.error.message);
      if (duplicate.data) throw httpError('这个 GitHub 账号已连接到其他 Techunter 用户。', 409);
      return { tokens, identity: { login: githubUser.login, avatarUrl: githubUser.avatar_url ?? null } };
    });
    return reply.type('text/html; charset=utf-8').send(githubAuthorizationCompletePage());
  });

  app.delete('/api/auth/github', async (request) => {
    await connections.disconnect(request.currentUser.id);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies['techunter_session'];
    if (token) await database().from('sessions').delete().eq('token_hash', hashToken(token));
    reply.clearCookie('techunter_session', { path: '/' });
    return { ok: true };
  });
}

export function assertRole(request: FastifyRequest, roles: User['role'][]): void {
  if (!roles.includes(request.currentUser.role)) throw httpError('当前账号没有执行此操作的权限。', 403);
}
