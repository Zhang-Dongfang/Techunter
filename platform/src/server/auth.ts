import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '../shared/contracts.js';
import { config } from './config.js';
import { Database, ensureUser } from './database.js';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: User;
  }
}

function mapUser(row: Record<string, unknown>): User {
  return {
    id: String(row['id']),
    login: String(row['login']),
    name: String(row['name']),
    avatarUrl: row['avatar_url'] ? String(row['avatar_url']) : null,
    role: row['role'] as User['role'],
  };
}

function makeSession(database: Database, userId: string): string {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  database.raw.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, expires, new Date().toISOString());
  return token;
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie('techunter_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.publicUrl.startsWith('https://'),
    path: '/',
    maxAge: 14 * 24 * 60 * 60,
  });
}

export function registerAuth(app: FastifyInstance, database: Database, demoAdminId: string): void {
  app.decorateRequest('currentUser');

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const publicAuthRoute =
      request.url.startsWith('/api/auth/github') ||
      request.url.startsWith('/api/auth/demo') ||
      request.url.startsWith('/api/auth/logout') ||
      request.url.startsWith('/api/github/webhook');
    if (publicAuthRoute) return;
    const token = request.cookies['techunter_session'];
    let row: Record<string, unknown> | undefined;
    if (token) {
      row = database.raw.prepare(`
        SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > ?
      `).get(token, new Date().toISOString()) as Record<string, unknown> | undefined;
    }
    if (!row && config.demoMode) {
      row = database.raw.prepare('SELECT * FROM users WHERE id = ?').get(demoAdminId) as Record<string, unknown>;
    }
    if (!row) return reply.code(401).send({ error: '请先登录 Techunter。', code: 'UNAUTHENTICATED' });
    request.currentUser = mapUser(row);
  });

  app.get('/api/auth/me', async (request) => ({ user: request.currentUser }));

  app.get('/api/auth/demo-users', async (_request, reply) => {
    if (!config.demoMode) return reply.code(404).send({ error: '接口不存在。' });
    const rows = database.raw.prepare('SELECT * FROM users ORDER BY role, name').all() as Array<Record<string, unknown>>;
    return { users: rows.map(mapUser) };
  });

  app.post('/api/auth/demo', async (request, reply) => {
    if (!config.demoMode) return reply.code(404).send({ error: '接口不存在。' });
    const login = String((request.body as { login?: string } | null)?.login ?? '');
    const row = database.raw.prepare('SELECT * FROM users WHERE login = ?').get(login) as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: '演示用户不存在。' });
    const user = mapUser(row);
    const token = makeSession(database, user.id);
    setSessionCookie(reply, token);
    return { user };
  });

  app.get('/api/auth/github', async (_request, reply) => {
    if (!config.github.clientId) return reply.code(503).send({ error: '未配置 GitHub OAuth。' });
    const state = randomBytes(24).toString('base64url');
    reply.setCookie('github_oauth_state', state, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 600 });
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', config.github.clientId);
    url.searchParams.set('redirect_uri', `${config.publicUrl}/api/auth/github/callback`);
    url.searchParams.set('scope', 'read:user read:org');
    url.searchParams.set('state', state);
    return reply.redirect(url.toString());
  });

  app.get('/api/auth/github/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string };
    if (!query.code || !query.state || query.state !== request.cookies['github_oauth_state']) {
      return reply.code(400).send({ error: 'GitHub 登录状态校验失败。' });
    }
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: config.github.clientId,
        client_secret: config.github.clientSecret,
        code: query.code,
      }),
    });
    const tokenJson = await tokenResponse.json() as { access_token?: string; error_description?: string };
    if (!tokenJson.access_token) return reply.code(401).send({ error: tokenJson.error_description ?? 'GitHub 登录失败。' });
    const headers = { authorization: `Bearer ${tokenJson.access_token}`, accept: 'application/vnd.github+json' };
    const userResponse = await fetch('https://api.github.com/user', { headers });
    const githubUser = await userResponse.json() as { login: string; name?: string; avatar_url?: string };
    if (config.github.allowedOrg) {
      const orgsResponse = await fetch('https://api.github.com/user/orgs?per_page=100', { headers });
      const orgs = await orgsResponse.json() as Array<{ login: string }>;
      if (!orgs.some((org) => org.login.toLowerCase() === config.github.allowedOrg.toLowerCase())) {
        return reply.code(403).send({ error: `仅允许 ${config.github.allowedOrg} 企业成员登录。` });
      }
    }
    const userId = ensureUser(database, {
      login: githubUser.login,
      name: githubUser.name || githubUser.login,
      avatarUrl: githubUser.avatar_url,
    });
    const token = makeSession(database, userId);
    setSessionCookie(reply, token);
    database.audit(userId, 'auth.github_login', 'user', userId, { tokenFingerprint: createHash('sha256').update(token).digest('hex').slice(0, 12) });
    return reply.redirect(config.webUrl);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies['techunter_session'];
    if (token) database.raw.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    reply.clearCookie('techunter_session', { path: '/' });
    return { ok: true };
  });
}

export function assertRole(request: FastifyRequest, roles: User['role'][]): void {
  if (!roles.includes(request.currentUser.role)) {
    const error = new Error('当前账号没有执行此操作的权限。') as Error & { statusCode?: number };
    error.statusCode = 403;
    throw error;
  }
}
