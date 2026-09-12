import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { PGlite } from '@electric-sql/pglite';
import { registerAuth } from '../dist/auth.js';
import { GitHubConnectionService } from '../dist/github-connection-service.js';
import { encryptCredential, decryptCredential } from '../dist/credential-vault.js';

Object.assign(process.env, {
  NODE_ENV: 'test', SUPABASE_URL: 'https://database.fixture.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role-key-never-real',
  TECHUNTER_CREDENTIAL_ENCRYPTION_KEY: 'fixture-encryption-key-never-real-123456789',
  TECHUNTER_PUBLIC_URL: 'http://127.0.0.1:4310',
  GITHUB_CLIENT_ID: 'fixture-client', GITHUB_CLIENT_SECRET: 'fixture-secret',
});
const db = new PGlite({ parsers: { 1184: value => value } });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function rpc(name, args) {
  assert.match(name, /^[a-z_]+$/);
  const entries = Object.entries(args);
  for (const [key] of entries) assert.match(key, /^[a-z_]+$/);
  return (await db.query(`select techunter.${name}(${entries.map(([key], i) => `${key} => $${i + 1}`).join(',')}) as value`,
    entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value))).rows[0].value;
}
const port = { async rpc(name, args) { try { return { data: await rpc(name, args), error: null }; } catch (error) { return { data: null, error: { message: error.message } }; } } };
let userId;
before(async () => {
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const root = new URL('../../../infra/supabase/migrations/', import.meta.url);
  const latest = '202609120007_delivery_and_connection_recovery.sql';
  for (const name of fs.readdirSync(root).filter(name => name.endsWith('.sql') && name < latest).sort()) await db.exec(fs.readFileSync(new URL(name, root), 'utf8'));
  userId = (await db.query("insert into techunter.users(login,name,conexus_user_id,github_login) values('fixture','Fixture',$1,'fixture-gh') returning id", [randomUUID()])).rows[0].id;
  await db.query('insert into techunter.github_connections(user_id,credential,refresh_credential) values($1,$2,$3)', [userId, encryptCredential('legacy-access'), encryptCredential('legacy-refresh')]);
  await db.exec(fs.readFileSync(new URL(latest, root), 'utf8'));
});
after(() => db.close());
const connection = async () => (await db.query('select * from techunter.github_connections where user_id=$1', [userId])).rows[0];
async function expire() {
  await db.query("update techunter.github_connections set credential=$2,refresh_credential=$3,access_expires_at=now()-interval '1 minute',refresh_expires_at=now()+interval '1 day',lease_token=null,lease_until=null where user_id=$1",
    [userId, encryptCredential('old-access'), encryptCredential('one-use-refresh')]);
}

test('upgrade preserves existing credentials and restricts connection RPCs to the service role', async () => {
  const row = await connection();
  assert.equal(decryptCredential(row.credential), 'legacy-access'); assert.equal(decryptCredential(row.refresh_credential), 'legacy-refresh');
  assert.match(row.connection_version, /^[a-f0-9-]{36}$/); assert.equal(row.lease_token, null);
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query("select has_function_privilege($1,'techunter.lease_github_connection(uuid,uuid)','execute') as allowed", [role])).rows[0].allowed, false);
    assert.equal((await db.query("select has_function_privilege($1,'techunter.save_github_connection(uuid,uuid,uuid,jsonb,jsonb)','execute') as allowed", [role])).rows[0].allowed, false);
  }
});

test('separate API instances rotate once and disconnect waits, revokes the latest token, and stays disconnected', async () => {
  const originalFetch = globalThis.fetch;
  const session = { user_id: userId, expires_at: new Date(Date.now() + 30 * 86400000).toISOString(), idle_expires_at: new Date(Date.now() + 7 * 86400000).toISOString() };
  let refreshCalls = 0, started = deferred(), releaseRefresh = deferred(), busy = deferred();
  const revoked = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.href === 'https://github.com/login/oauth/access_token') {
      refreshCalls++; assert.equal(refreshCalls, 1, 'only one process may consume a refresh token');
      started.resolve(); await releaseRefresh.promise;
      return json({ access_token: 'new-access', expires_in: 28800, refresh_token: 'next-refresh', refresh_token_expires_in: 86400 });
    }
    if (url.hostname === 'api.github.com' && request.method === 'DELETE') { revoked.push((await request.json()).access_token); return new Response(null, { status: 204 }); }
    assert.equal(url.hostname, 'database.fixture.invalid', `unexpected network call: ${url.hostname}`);
    const name = url.pathname.split('/').at(-1);
    if (url.pathname.includes('/rpc/')) {
      try {
        const result = await rpc(name, await request.json());
        if (name === 'lease_github_connection' && result === null) busy.resolve();
        return json(result);
      } catch (error) { return json({ message: error.message, code: error.code }, 400); }
    }
    if (name === 'sessions') return json([session]);
    if (name === 'users') return json((await db.query('select * from techunter.users where id=$1', [userId])).rows[0]);
    if (name === 'github_connections') return json([await connection()]);
    if (name === 'audit_events' && request.method === 'POST') return new Response(null, { status: 201 });
    throw new Error(`unhandled fixture request: ${request.method} ${name}`);
  };
  const apps = [Fastify(), Fastify()];
  try {
    for (const app of apps) {
      await app.register(cookie); registerAuth(app);
      app.get('/api/needs-github', (request, reply) => request.githubCredential ? { githubConnected: true } : reply.code(401).send({ code: 'GITHUB_ACCOUNT_REQUIRED' }));
    }
    const headers = { cookie: 'techunter_session=fixture-session' };
    await expire();
    const first = apps[0].inject({ url: '/api/needs-github', headers }); await started.promise;
    const second = apps[1].inject({ url: '/api/needs-github', headers }); await busy.promise;
    releaseRefresh.resolve();
    assert.deepEqual((await Promise.all([first, second])).map(response => response.statusCode), [200, 200]);
    assert.equal(refreshCalls, 1);

    await expire(); refreshCalls = 0; started = deferred(); releaseRefresh = deferred(); busy = deferred();
    const pending = apps[0].inject({ url: '/api/needs-github', headers }); await started.promise;
    const disconnect = apps[1].inject({ method: 'DELETE', url: '/api/auth/github', headers }); await busy.promise;
    assert.equal(revoked.length, 0);
    releaseRefresh.resolve();
    assert.equal((await pending).statusCode, 200); assert.equal((await disconnect).statusCode, 200);
    assert.deepEqual(revoked, ['new-access']); assert.equal((await connection()).credential, null);
    const me = (await apps[0].inject({ url: '/api/auth/me', headers })).json();
    assert.equal(me.githubConnected, false); assert.equal(me.user.githubLogin, null);
  } finally { releaseRefresh.resolve(); await Promise.all(apps.map(app => app.close())); globalThis.fetch = originalFetch; }
});

test('expired writers and OAuth states cannot restore a disconnected or rebound connection', async () => {
  await expire();
  const staleToken = randomUUID(), currentToken = randomUUID();
  const stale = await rpc('lease_github_connection', { p_user_id: userId, p_token: staleToken });
  await db.query("update techunter.github_connections set lease_until=now()-interval '1 second' where user_id=$1", [userId]);
  const current = await rpc('lease_github_connection', { p_user_id: userId, p_token: currentToken });
  await rpc('disconnect_github_connection', { p_user_id: userId, p_token: currentToken, p_version: current.connection_version });
  await rpc('release_github_connection', { p_user_id: userId, p_token: currentToken });
  await assert.rejects(() => rpc('renew_github_connection', { p_user_id: userId, p_token: staleToken }), /GITHUB_CONNECTION_CHANGED/);
  await assert.rejects(() => rpc('save_github_connection', { p_user_id: userId, p_token: staleToken, p_version: stale.connection_version,
    p_credentials: { credential: encryptCredential('stale-token') } }), /GITHUB_CONNECTION_CHANGED/);
  const service = new GitHubConnectionService(async () => assert.fail('refresh should not run'), async () => {}, () => port);
  await assert.rejects(() => service.connect(userId, stale.connection_version, async () => assert.fail('stale callback must not exchange a code')), { code: 'GITHUB_CONNECTION_CHANGED' });
  const version = await service.version(userId);
  await service.connect(userId, version, async () => ({ tokens: { accessToken: 'reconnected', accessExpiresAt: null, refreshToken: null, refreshExpiresAt: null }, identity: { login: 'new-gh', avatarUrl: null } }));
  assert.equal(decryptCredential((await connection()).credential), 'reconnected');
  await assert.rejects(() => service.connect(userId, version, async () => assert.fail('replayed callback')), { code: 'GITHUB_CONNECTION_CHANGED' });
  assert.equal((await db.query('select github_login from techunter.users where id=$1', [userId])).rows[0].github_login, 'new-gh');
});

test('failed remote revocation preserves credentials for a retry instead of reporting success', async () => {
  const service = new GitHubConnectionService(async () => assert.fail(), async () => { throw new Error('remote unavailable'); }, () => port);
  await assert.rejects(() => service.disconnect(userId), /remote unavailable/);
  assert.equal(decryptCredential((await connection()).credential), 'reconnected'); assert.equal((await connection()).lease_token, null);
});

test('disconnect alone refreshes an expired credential under its lease before revocation', async () => {
  await expire(); const revoked = []; let rotations = 0;
  const service = new GitHubConnectionService(async () => {
    rotations++;
    return { accessToken: 'rotated-for-disconnect', accessExpiresAt: null, refreshToken: 'rotated-refresh', refreshExpiresAt: null };
  }, async token => { revoked.push(token); }, () => port);
  await service.disconnect(userId);
  assert.equal(rotations, 1); assert.deepEqual(revoked, ['rotated-for-disconnect']);
  assert.equal((await connection()).credential, null); assert.equal((await connection()).refresh_credential, null);
});
