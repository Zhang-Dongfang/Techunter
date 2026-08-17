import fs from 'node:fs';
import path from 'node:path';

try {
  if (fs.existsSync(path.resolve(process.cwd(), '.env'))) process.loadEnvFile(path.resolve(process.cwd(), '.env'));
} catch {
  // Environment variables supplied by the process remain authoritative.
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const cwd = process.cwd();

export const config = {
  host: process.env['TECHUNTER_HOST'] ?? '127.0.0.1',
  port: int(process.env['TECHUNTER_PORT'], 4310),
  publicUrl: process.env['TECHUNTER_PUBLIC_URL'] ?? 'http://127.0.0.1:4310',
  webUrl: process.env['TECHUNTER_WEB_URL'] ?? 'http://127.0.0.1:5173',
  dataDir: path.resolve(cwd, process.env['TECHUNTER_DATA_DIR'] ?? '.data'),
  demoMode: bool(process.env['TECHUNTER_DEMO_MODE'], true),
  demoRepoPath: path.resolve(cwd, process.env['TECHUNTER_DEMO_REPO_PATH'] ?? '..'),
  github: {
    clientId: process.env['GITHUB_CLIENT_ID'] ?? '',
    clientSecret: process.env['GITHUB_CLIENT_SECRET'] ?? '',
    allowedOrg: process.env['GITHUB_ALLOWED_ORG'] ?? '',
    appId: process.env['GITHUB_APP_ID'] ?? '',
    installationId: process.env['GITHUB_INSTALLATION_ID'] ?? '',
    privateKey: (process.env['GITHUB_PRIVATE_KEY'] ?? '').replace(/\\n/g, '\n'),
    webhookSecret: process.env['GITHUB_WEBHOOK_SECRET'] ?? '',
    token: process.env['GITHUB_TOKEN'] ?? '',
  },
  ai: {
    apiKey: process.env['AI_API_KEY'] ?? '',
    baseUrl: process.env['AI_BASE_URL'] ?? 'https://openrouter.ai/api/v1',
    model: process.env['AI_MODEL'] ?? 'z-ai/glm-5',
  },
} as const;

fs.mkdirSync(config.dataDir, { recursive: true });
