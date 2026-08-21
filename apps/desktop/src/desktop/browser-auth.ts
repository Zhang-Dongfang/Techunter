import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { ConexusAccountAuthorization } from '@techunter/core';

const CALLBACK_TIMEOUT_MS = 5 * 60_000;
const MAX_CALLBACK_BODY_BYTES = 16 * 1024;

export interface ConexusBrowserAuthInput {
  apiUrl: string;
  publicationSlug: string;
  displayName: string;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function validConexusApiUrl(value: string): URL {
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Conexus 登录地址必须使用 HTTPS。');
  }
  return url;
}

function authorization(value: unknown): ConexusAccountAuthorization {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Conexus 浏览器授权无效。');
  const record = value as Record<string, unknown>;
  const user = record['user'];
  if (!user || typeof user !== 'object' || Array.isArray(user)) throw new Error('Conexus 浏览器账号无效。');
  const account = user as Record<string, unknown>;
  const result: ConexusAccountAuthorization = {
    runTicket: typeof record['runTicket'] === 'string' ? record['runTicket'] : '',
    expiresAt: typeof record['expiresAt'] === 'string' ? record['expiresAt'] : '',
    user: {
      id: typeof account['id'] === 'string' ? account['id'] : '',
      email: typeof account['email'] === 'string' ? account['email'] : '',
      name: typeof account['name'] === 'string' ? account['name'] : '',
      role: account['role'] === 'admin' ? 'admin' : 'user',
      status: typeof account['status'] === 'string' ? account['status'] : '',
      monthlyTokenLimit: Number(account['monthlyTokenLimit'] ?? 0),
    },
  };
  if (
    !result.runTicket.startsWith('cnx_run_v1.') || result.runTicket.length > 8 * 1024 ||
    !result.user.id || !result.user.email || result.user.status !== 'active' ||
    !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now()
  ) throw new Error('Conexus 浏览器授权已失效或内容不完整。');
  return result;
}

function callbackPage(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>正在返回 Techunter</title><style>body{min-height:100vh;margin:0;display:grid;place-items:center;background:#0b0d10;color:#f5f7fa;font:14px system-ui}.card{max-width:420px;padding:32px;border:1px solid #30343b;border-radius:16px;background:#17191d;text-align:center}h1{font-size:20px}p{color:#aeb4bf;line-height:1.6}</style></head><body><main class="card"><h1>正在返回 Techunter</h1><p id="status">正在安全地完成浏览器授权…</p></main><script>(()=>{const p=new URLSearchParams(location.hash.slice(1));fetch('/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state:p.get('state')||'',authorization:p.get('authorization')||''})}).then(r=>{if(!r.ok)throw new Error();document.getElementById('status').textContent='登录成功，可以关闭这个页面。'}).catch(()=>{document.getElementById('status').textContent='授权回传失败，请返回 Techunter 重试。'})})()</script></body></html>`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_CALLBACK_BODY_BYTES) throw new Error('Conexus 回调内容过大。');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(response: ServerResponse, status: number, body = ''): void {
  response.writeHead(status, {
    'Content-Type': body ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

export async function authorizeConexusInBrowser(
  input: ConexusBrowserAuthInput,
  rendererOrigin: string,
  openExternal: (url: string) => Promise<void>,
): Promise<ConexusAccountAuthorization> {
  const apiUrl = validConexusApiUrl(input.apiUrl);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.publicationSlug)) throw new Error('Conexus publication slug 无效。');
  const audience = new URL(rendererOrigin).origin;
  const state = randomBytes(32).toString('base64url');

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: ConexusAccountAuthorization) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      if (error) reject(error);
      else resolve(result!);
    };
    const server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (request.method === 'GET' && url.pathname === '/callback') {
          send(response, 200, callbackPage());
          return;
        }
        if (request.method === 'POST' && url.pathname === '/complete') {
          try {
            const body = JSON.parse(await readBody(request)) as { state?: unknown; authorization?: unknown };
            if (typeof body.state !== 'string' || !safeEqual(body.state, state)) throw new Error('Conexus 回调状态校验失败。');
            if (typeof body.authorization !== 'string') throw new Error('Conexus 回调缺少授权。');
            const result = authorization(JSON.parse(body.authorization));
            send(response, 204);
            finish(undefined, result);
          } catch (error) {
            send(response, 400);
            finish(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }
        send(response, 404);
      })().catch((error: unknown) => {
        send(response, 500);
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    });
    const timeout = setTimeout(() => finish(new Error('等待 Conexus 浏览器登录超时，请重试。')), CALLBACK_TIMEOUT_MS);
    server.once('error', (error) => finish(error));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        finish(new Error('无法创建 Conexus 本机回调地址。'));
        return;
      }
      const loginUrl = new URL('/v1/auth/web', apiUrl);
      loginUrl.searchParams.set('audience', audience);
      loginUrl.searchParams.set('publicationSlug', input.publicationSlug);
      loginUrl.searchParams.set('displayName', input.displayName);
      loginUrl.searchParams.set('redirectUri', `http://127.0.0.1:${address.port}/callback`);
      loginUrl.searchParams.set('state', state);
      void openExternal(loginUrl.toString()).catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    });
  });
}
