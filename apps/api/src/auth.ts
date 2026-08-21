import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@techunter/core';
import { config } from './config.js';
import { ConexusAccountService } from './conexus-account-service.js';
import { decryptCredential, encryptCredential } from './credential-vault.js';
import { database, dataOrThrow } from './database.js';
import { httpError } from './errors.js';
import { issueGitHubOAuthState, verifyGitHubOAuthState } from './github-oauth-state.js';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: User;
    modelAuthorization?: { credential: string; audience: string };
    githubCredential?: string;
    sessionTokenHash?: string;
  }
}

type Row = Record<string, any>;

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

async function sessionByTokenHash(tokenHash: string): Promise<{ row: Row; user: User } | null> {
  const result = await database().from('sessions').select('*').eq('token_hash', tokenHash).gt('expires_at', new Date().toISOString()).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) return null;
  const userResult = await database().from('users').select('*').eq('id', result.data.user_id).single();
  if (userResult.error) throw new Error(userResult.error.message);
  return { row: { ...result.data, token_hash: tokenHash }, user: mapUser(userResult.data as Row) };
}

async function session(token: string | undefined): Promise<{ row: Row; user: User } | null> {
  return token ? sessionByTokenHash(hashToken(token)) : null;
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

async function ensureUser(authorization: Awaited<ReturnType<ConexusAccountService['introspect']>>): Promise<User> {
  const existing = await database().from('users').select('*').eq('conexus_user_id', authorization.user.id).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  const login = authorization.user.email.split('@')[0] || `hunter-${authorization.user.id.slice(0, 8)}`;
  const role = authorization.user.role === 'admin' ? 'admin' : (existing.data?.role ?? 'member');
  const payload = {
    conexus_user_id: authorization.user.id,
    login: existing.data?.login ?? login,
    name: authorization.user.name || existing.data?.name || login,
    email: authorization.user.email,
    role,
  };
  const row = existing.data
    ? dataOrThrow(await database().from('users').update(payload).eq('id', existing.data.id).select('*').single())
    : dataOrThrow(await database().from('users').insert(payload).select('*').single());
  return mapUser(row as unknown as Row);
}

export function registerAuth(app: FastifyInstance, conexus = new ConexusAccountService()): void {
  app.decorateRequest('currentUser');
  app.decorateRequest('modelAuthorization');
  app.decorateRequest('githubCredential');
  app.decorateRequest('sessionTokenHash');

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const isPublic =
      request.url.startsWith('/api/auth/conexus') ||
      request.url.startsWith('/api/auth/github/callback') ||
      request.url.startsWith('/api/auth/logout') ||
      request.url.startsWith('/api/github/webhook');
    if (isPublic) return;
    const current = await session(request.cookies['techunter_session']);
    if (!current) return reply.code(401).send({ error: '请先登录 Techunter。', code: 'UNAUTHENTICATED' });
    request.currentUser = current.user;
    request.sessionTokenHash = String(current.row['token_hash']);
    const modelCredential = decryptCredential(current.row['model_credential']);
    const modelAudience = current.row['model_audience'] ? String(current.row['model_audience']) : undefined;
    if (modelCredential && modelAudience) request.modelAuthorization = { credential: modelCredential, audience: modelAudience };
    request.githubCredential = decryptCredential(current.row['github_credential']);
  });

  app.get('/api/auth/conexus/config', async () => ({
    apiUrl: config().conexus.apiUrl,
    publicationSlug: config().conexus.publicationSlug,
    displayName: 'Techunter',
  }));

  app.post('/api/auth/conexus', async (request, reply) => {
    const input = request.body as { runTicket?: unknown; audience?: unknown } | null;
    const runTicket = typeof input?.runTicket === 'string' ? input.runTicket : '';
    const audience = typeof input?.audience === 'string' ? input.audience : '';
    if (!runTicket.startsWith('cnx_run_v1.') || runTicket.length > 8 * 1024 || !allowedAudience(audience)) {
      throw httpError('Conexus 授权参数无效。', 400, 'INVALID_AUTHORIZATION');
    }
    const authorization = await conexus.introspect(runTicket, new URL(audience).origin);
    const user = await ensureUser(authorization);
    const token = randomBytes(32).toString('base64url');
    const insert = await database().from('sessions').insert({
      token_hash: hashToken(token),
      user_id: user.id,
      model_credential: encryptCredential(runTicket),
      model_audience: authorization.audience,
      expires_at: authorization.expiresAt,
    });
    if (insert.error) throw new Error(insert.error.message);
    setSessionCookie(reply, token, authorization.expiresAt);
    await database().from('audit_events').insert({
      actor_id: user.id,
      action: 'auth.conexus_login',
      entity_type: 'user',
      entity_id: user.id,
      payload_json: { audience: authorization.audience, ticketFingerprint: hashToken(runTicket).slice(0, 12) },
    });
    return { user, expiresAt: authorization.expiresAt };
  });

  app.get('/api/auth/me', async (request) => ({ user: request.currentUser }));

  app.post('/api/auth/github', async (request) => {
    const github = config().github;
    if (!github.clientId || !github.clientSecret) throw httpError('未配置 GitHub OAuth。', 503);
    if (!request.sessionTokenHash) throw httpError('请先登录 Conexus，再连接 GitHub。', 401);
    const state = issueGitHubOAuthState(request.sessionTokenHash, config().credentialEncryptionKey);
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
    try {
      sessionTokenHash = verifyGitHubOAuthState(query.state, config().credentialEncryptionKey).sessionTokenHash;
    } catch (error) {
      throw httpError((error as Error).message, 400);
    }
    const current = await sessionByTokenHash(sessionTokenHash);
    if (!current) throw httpError('Techunter 登录已失效，请重新登录 Conexus。', 401);
    const github = config().github;
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: github.clientId, client_secret: github.clientSecret, code: query.code }),
    });
    const tokenJson = await tokenResponse.json() as { access_token?: string; error_description?: string };
    if (!tokenJson.access_token) throw httpError(tokenJson.error_description ?? 'GitHub 登录失败。', 401);
    const headers = { authorization: `Bearer ${tokenJson.access_token}`, accept: 'application/vnd.github+json' };
    const githubUser = await (await fetch('https://api.github.com/user', { headers })).json() as { login: string; avatar_url?: string };
    if (github.allowedOrg) {
      const orgs = await (await fetch('https://api.github.com/user/orgs?per_page=100', { headers })).json() as Array<{ login: string }>;
      if (!orgs.some((org) => org.login.toLowerCase() === github.allowedOrg.toLowerCase())) throw httpError(`仅允许 ${github.allowedOrg} 企业成员连接。`, 403);
    }
    const duplicate = await database().from('users').select('id').eq('github_login', githubUser.login).neq('id', current.user.id).maybeSingle();
    if (duplicate.error) throw new Error(duplicate.error.message);
    if (duplicate.data) throw httpError('这个 GitHub 账号已连接到其他 Techunter 用户。', 409);
    const [userUpdate, sessionUpdate] = await Promise.all([
      database().from('users').update({ github_login: githubUser.login, avatar_url: githubUser.avatar_url ?? null }).eq('id', current.user.id),
      database().from('sessions').update({ github_credential: encryptCredential(tokenJson.access_token) }).eq('token_hash', current.row['token_hash']),
    ]);
    if (userUpdate.error) throw new Error(userUpdate.error.message);
    if (sessionUpdate.error) throw new Error(sessionUpdate.error.message);
    return reply.type('text/html; charset=utf-8').send(githubAuthorizationCompletePage());
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
