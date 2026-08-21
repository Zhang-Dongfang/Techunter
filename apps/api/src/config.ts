import { z } from 'zod';
import {
  DEFAULT_CONEXUS_API_URL,
  DEFAULT_CONEXUS_AUDIENCE,
  DEFAULT_CONEXUS_BASE_URL,
  DEFAULT_CONEXUS_PUBLICATION_SLUG,
  DEFAULT_MODEL,
  type AiAccessMode,
} from '@techunter/core';

const optional = z.preprocess((value) => value === '' ? undefined : value, z.string().optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4310),
  TECHUNTER_PUBLIC_URL: z.string().url().default('http://127.0.0.1:4310'),
  TECHUNTER_WEB_ORIGINS: z.string().default('http://127.0.0.1:5173'),
  TECHUNTER_PROJECT_INITIAL_POINTS: z.coerce.number().int().min(0).default(10_000),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  TECHUNTER_CREDENTIAL_ENCRYPTION_KEY: z.string().min(32),
  CONEXUS_API_URL: z.string().url().default(DEFAULT_CONEXUS_API_URL),
  CONEXUS_PUBLICATION_SLUG: z.string().min(1).default(DEFAULT_CONEXUS_PUBLICATION_SLUG),
  GITHUB_CLIENT_ID: optional,
  GITHUB_CLIENT_SECRET: optional,
  GITHUB_ALLOWED_ORG: optional,
  GITHUB_APP_ID: optional,
  GITHUB_INSTALLATION_ID: optional,
  GITHUB_PRIVATE_KEY: optional,
  GITHUB_WEBHOOK_SECRET: optional,
  AI_ACCESS_MODE: z.enum(['direct', 'conexus']).default('conexus'),
  AI_API_KEY: optional,
  AI_BASE_URL: z.string().url().default(DEFAULT_CONEXUS_BASE_URL),
  AI_MODEL: optional,
  AI_AUDIENCE: z.string().default(DEFAULT_CONEXUS_AUDIENCE),
});

export type ApiConfig = ReturnType<typeof parseConfig>;

export function parseConfig(environment: NodeJS.ProcessEnv) {
  const value = schema.parse(environment);
  return {
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    publicUrl: value.TECHUNTER_PUBLIC_URL.replace(/\/+$/, ''),
    webOrigins: value.TECHUNTER_WEB_ORIGINS.split(',').map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean),
    initialProjectPoints: value.TECHUNTER_PROJECT_INITIAL_POINTS,
    supabaseUrl: value.SUPABASE_URL,
    supabaseServiceRoleKey: value.SUPABASE_SERVICE_ROLE_KEY,
    credentialEncryptionKey: value.TECHUNTER_CREDENTIAL_ENCRYPTION_KEY,
    conexus: {
      apiUrl: value.CONEXUS_API_URL.replace(/\/+$/, ''),
      publicationSlug: value.CONEXUS_PUBLICATION_SLUG,
    },
    github: {
      clientId: value.GITHUB_CLIENT_ID ?? '',
      clientSecret: value.GITHUB_CLIENT_SECRET ?? '',
      allowedOrg: value.GITHUB_ALLOWED_ORG ?? '',
      appId: value.GITHUB_APP_ID ?? '',
      installationId: value.GITHUB_INSTALLATION_ID ?? '',
      privateKey: (value.GITHUB_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
      webhookSecret: value.GITHUB_WEBHOOK_SECRET ?? '',
    },
    ai: {
      accessMode: value.AI_ACCESS_MODE as AiAccessMode,
      apiKey: value.AI_API_KEY ?? '',
      baseUrl: value.AI_BASE_URL,
      model: value.AI_MODEL ?? (value.AI_ACCESS_MODE === 'direct' ? DEFAULT_MODEL : ''),
      audience: value.AI_AUDIENCE,
    },
  };
}

let cached: ApiConfig | undefined;
export function config(): ApiConfig {
  if (!cached) cached = parseConfig(process.env);
  return cached;
}
