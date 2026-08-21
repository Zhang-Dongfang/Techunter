import type { TechunterConfig } from '../types.js';
import { setConfig } from './config.js';
import {
  DEFAULT_CONEXUS_API_URL,
  DEFAULT_CONEXUS_AUDIENCE,
  DEFAULT_CONEXUS_BASE_URL,
  DEFAULT_CONEXUS_PUBLICATION_SLUG,
} from './client.js';

interface AccountSession {
  accessToken: string;
  refreshToken: string;
}

interface AccountLogin {
  session: AccountSession;
  user: { email: string };
}

interface RunTicket {
  runTicket: string;
  expiresAt: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function apiUrl(config: TechunterConfig): string {
  const baseUrl = config.aiBaseUrl ?? DEFAULT_CONEXUS_BASE_URL;
  const suffix = '/v1/runtime/llm';
  return baseUrl.endsWith(suffix) ? baseUrl.slice(0, -suffix.length) : DEFAULT_CONEXUS_API_URL;
}

async function request(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const payload = record(await response.json().catch(() => null));
  if (!response.ok) {
    const error = record(payload['error']);
    throw new Error(String(error['message'] || payload['message'] || `Conexus 请求失败 (${response.status})`));
  }
  return payload;
}

function session(payload: Record<string, unknown>): AccountSession {
  const value = record(payload['session']);
  const result = {
    accessToken: String(value['accessToken'] || ''),
    refreshToken: String(value['refreshToken'] || ''),
  };
  if (!result.accessToken || !result.refreshToken) throw new Error('Conexus 未返回有效账号会话。');
  return result;
}

async function issueRunTicket(config: TechunterConfig, accessToken: string): Promise<RunTicket> {
  const payload = await request(`${apiUrl(config)}/v1/runtime/run-tickets`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      audience: config.aiAudience ?? DEFAULT_CONEXUS_AUDIENCE,
      publicationSlug: config.aiPublicationSlug ?? DEFAULT_CONEXUS_PUBLICATION_SLUG,
    }),
  });
  const result = {
    runTicket: String(payload['runTicket'] || ''),
    expiresAt: String(payload['expiresAt'] || ''),
  };
  if (!result.runTicket.startsWith('cnx_run_v1.') || !Number.isFinite(Date.parse(result.expiresAt))) {
    throw new Error('Conexus 未返回有效 Run Ticket。');
  }
  return result;
}

export async function loginConexusAccount(
  config: TechunterConfig,
  email: string,
  password: string,
): Promise<TechunterConfig> {
  const payload = await request(`${apiUrl(config)}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }) as unknown as AccountLogin;
  const accountSession = session(payload as unknown as Record<string, unknown>);
  const ticket = await issueRunTicket(config, accountSession.accessToken);
  const account = record((payload as unknown as Record<string, unknown>)['user']);
  const next: TechunterConfig = {
    ...config,
    aiAccessMode: 'conexus',
    aiBaseUrl: config.aiBaseUrl ?? DEFAULT_CONEXUS_BASE_URL,
    aiAudience: config.aiAudience ?? DEFAULT_CONEXUS_AUDIENCE,
    aiPublicationSlug: config.aiPublicationSlug ?? DEFAULT_CONEXUS_PUBLICATION_SLUG,
    aiApiKey: ticket.runTicket,
    conexusRefreshToken: accountSession.refreshToken,
    conexusTicketExpiresAt: ticket.expiresAt,
    conexusAccountEmail: String(account['email'] || email),
  };
  setConfig(next);
  return next;
}

export async function ensureConexusCredential(config: TechunterConfig): Promise<TechunterConfig> {
  if ((config.aiAccessMode ?? 'direct') !== 'conexus') return config;
  const expiresAt = Date.parse(config.conexusTicketExpiresAt ?? '');
  if (config.aiApiKey.startsWith('cnx_run_v1.') && Number.isFinite(expiresAt) && expiresAt > Date.now() + 5 * 60_000) {
    return config;
  }
  if (!config.conexusRefreshToken) {
    throw new Error('Conexus 登录已过期，请运行 `tch config` 重新登录。');
  }
  const payload = await request(`${apiUrl(config)}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: config.conexusRefreshToken }),
  });
  const accountSession = session(payload);
  const ticket = await issueRunTicket(config, accountSession.accessToken);
  const next = {
    ...config,
    aiApiKey: ticket.runTicket,
    conexusRefreshToken: accountSession.refreshToken,
    conexusTicketExpiresAt: ticket.expiresAt,
  };
  setConfig(next);
  return next;
}
