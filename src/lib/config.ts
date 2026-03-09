import Conf from 'conf';
import { z } from 'zod';
import type { TechunterConfig } from '../types.js';

const configSchema = z.object({
  aiApiKey: z.string().min(1),
  aiBaseUrl: z.string().optional(),
  aiModel: z.string().optional(),
  githubToken: z.string().min(1),
  githubClientId: z.string().optional(),
  github: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    baseBranch: z.string().optional(),
  }),
  taskState: z.object({
    activeIssueNumber: z.number().optional(),
    baseCommit: z.string().optional(),
  }).optional(),
});

const store = new Conf<TechunterConfig>({
  projectName: 'techunter',
  defaults: {} as TechunterConfig,
});

export function getConfig(): TechunterConfig {
  const raw = store.store;

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new Error('Configuration is missing or invalid.');
  }

  return result.data;
}

export function setConfig(partial: Partial<TechunterConfig>): void {
  const current = store.store as unknown as Record<string, unknown>;

  if (partial.github) {
    current['github'] = {
      ...(current['github'] as Record<string, unknown> | undefined ?? {}),
      ...partial.github,
    };
  }
  if (partial.aiApiKey !== undefined) {
    current['aiApiKey'] = partial.aiApiKey;
  }
  if (partial.aiBaseUrl !== undefined) {
    current['aiBaseUrl'] = partial.aiBaseUrl;
  }
  if (partial.aiModel !== undefined) {
    current['aiModel'] = partial.aiModel;
  }
  if (partial.githubToken !== undefined) {
    current['githubToken'] = partial.githubToken;
  }
  if (partial.githubClientId !== undefined) {
    current['githubClientId'] = partial.githubClientId;
  }
  if (partial.taskState !== undefined) {
    current['taskState'] = {
      ...(current['taskState'] as Record<string, unknown> | undefined ?? {}),
      ...partial.taskState,
    };
  }

  store.store = current as unknown as TechunterConfig;
}

export function getConfigPath(): string {
  return store.path;
}
