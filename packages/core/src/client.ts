import OpenAI from 'openai';
import type { FinalRequestOptions } from 'openai/core';
import { HttpsProxyAgent } from 'https-proxy-agent';

import type { AiConfig } from './types.js';

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_MODEL = 'z-ai/glm-5';
export const DEFAULT_CONEXUS_API_URL = 'https://conexus-production.up.railway.app';
export const DEFAULT_CONEXUS_BASE_URL = `${DEFAULT_CONEXUS_API_URL}/v1/runtime/llm`;
export const DEFAULT_CONEXUS_AUDIENCE = 'http://127.0.0.1:4310';
export const DEFAULT_CONEXUS_PUBLICATION_SLUG = 'techunter';
export const MANAGED_DEFAULT_MODEL = 'Railway managed default';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function secureUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} 必须是绝对 URL。`);
  }
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))) {
    throw new Error(`${label} 必须使用 HTTPS；本地回环开发地址可以使用 HTTP。`);
  }
  return url;
}

function conexusBaseUrl(value: string): string {
  const url = secureUrl(value, 'Conexus AI base URL');
  if (url.search || url.hash || !url.pathname.replace(/\/+$/, '').endsWith('/v1/runtime/llm')) {
    throw new Error('Conexus AI base URL 必须以 /v1/runtime/llm 结尾，且不能包含查询参数或片段。');
  }
  return url.toString().replace(/\/+$/, '');
}

function conexusAudience(value: string): string {
  const url = secureUrl(value, 'Conexus audience');
  if (url.origin !== url.toString().replace(/\/$/, '')) {
    throw new Error('Conexus audience 必须是 HTTP(S) origin，不能包含路径、查询参数或片段。');
  }
  return url.origin;
}

function conexusPublicationSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
    throw new Error('Conexus publication slug 必须是小写字母、数字和连字符组成的 kebab-case。');
  }
  return slug;
}

class ConexusOpenAI extends OpenAI {
  override buildRequest<Req>(input: FinalRequestOptions<Req>, options?: { retryCount?: number }) {
    if (input.path === '/chat/completions' && isRecord(input.body)) {
      const body = { ...input.body };
      delete body['model'];
      return super.buildRequest({ ...input, body: body as Req }, options);
    }
    return super.buildRequest(input, options);
  }
}

function proxyUrl(): string | undefined {
  return process.env['HTTPS_PROXY'] ?? process.env['https_proxy'] ??
    process.env['HTTP_PROXY'] ?? process.env['http_proxy'] ??
    process.env['ALL_PROXY'] ?? process.env['all_proxy'];
}

export function createAiClient(config: AiConfig): OpenAI {
  if (!config.aiApiKey.trim()) throw new Error('AI 未配置：请先设置 AI API Key。');
  const proxy = proxyUrl();
  const httpAgent = proxy ? new HttpsProxyAgent(proxy) : undefined;
  if ((config.aiAccessMode ?? 'direct') === 'conexus') {
    const credential = config.aiApiKey.trim();
    if (!credential.startsWith('cnx_run_v1.')) {
      throw new Error('Conexus 账号模式需要 cnx_run_v1 开头的短期 Run Ticket。');
    }
    return new ConexusOpenAI({
      baseURL: conexusBaseUrl(config.aiBaseUrl ?? DEFAULT_CONEXUS_BASE_URL),
      apiKey: credential,
      defaultHeaders: {
        'X-Conexus-Audience': conexusAudience(config.aiAudience ?? DEFAULT_CONEXUS_AUDIENCE),
        'X-Conexus-Publication': conexusPublicationSlug(config.aiPublicationSlug ?? DEFAULT_CONEXUS_PUBLICATION_SLUG),
      },
      ...(httpAgent ? { httpAgent } : {}),
    });
  }
  return new OpenAI({
    baseURL: config.aiBaseUrl ?? DEFAULT_BASE_URL,
    apiKey: config.aiApiKey,
    ...(httpAgent ? { httpAgent } : {}),
  });
}

export function getAiModel(config: AiConfig): string {
  if ((config.aiAccessMode ?? 'direct') === 'conexus') return MANAGED_DEFAULT_MODEL;
  return config.aiModel ?? DEFAULT_MODEL;
}
