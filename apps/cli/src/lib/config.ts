import { z } from 'zod';
import type { TechunterConfig } from '../types.js';
import { getTechunterConfigStore } from '@techunter/core';

const configSchema = z.object({
  aiApiKey: z.string().min(1),
  aiAccessMode: z.enum(['direct', 'conexus']).optional(),
  aiBaseUrl: z.string().optional(),
  aiModel: z.string().optional(),
  aiAudience: z.string().optional(),
  aiPublicationSlug: z.string().optional(),
  conexusRefreshToken: z.string().optional(),
  conexusTicketExpiresAt: z.string().optional(),
  conexusAccountEmail: z.string().optional(),
  githubToken: z.string().min(1),
  githubClientId: z.string().optional(),
  baseBranch: z.string().optional(),
  assetVcs: z.object({
    type: z.literal('svn'),
    url: z.string(),
    username: z.string().optional(),
    password: z.string().optional(),
    lockPaths: z.array(z.string()),
  }).optional(),
  github: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
  }),
  taskState: z.object({
    activeIssueNumber: z.number().optional(),
    baseCommit: z.string().optional(),
    activeBranch: z.string().optional(),
    resumeStack: z.array(z.object({
      originalBranch: z.string(),
      restoreStash: z.boolean(),
      taskStateSnapshot: z.object({
        activeIssueNumber: z.number().optional(),
        baseCommit: z.string().optional(),
        activeBranch: z.string().optional(),
      }).optional(),
    })).optional(),
  }).optional(),
});

const store = getTechunterConfigStore<TechunterConfig>();

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
  if (partial.aiAccessMode !== undefined) {
    current['aiAccessMode'] = partial.aiAccessMode;
  }
  if (partial.aiBaseUrl !== undefined) {
    current['aiBaseUrl'] = partial.aiBaseUrl;
  }
  if (partial.aiModel !== undefined) {
    current['aiModel'] = partial.aiModel;
  }
  if (partial.aiAudience !== undefined) {
    current['aiAudience'] = partial.aiAudience;
  }
  if (partial.aiPublicationSlug !== undefined) {
    current['aiPublicationSlug'] = partial.aiPublicationSlug;
  }
  if (partial.conexusRefreshToken !== undefined) {
    current['conexusRefreshToken'] = partial.conexusRefreshToken;
  }
  if (partial.conexusTicketExpiresAt !== undefined) {
    current['conexusTicketExpiresAt'] = partial.conexusTicketExpiresAt;
  }
  if (partial.conexusAccountEmail !== undefined) {
    current['conexusAccountEmail'] = partial.conexusAccountEmail;
  }
  if (partial.githubToken !== undefined) {
    current['githubToken'] = partial.githubToken;
  }
  if (partial.githubClientId !== undefined) {
    current['githubClientId'] = partial.githubClientId;
  }
  if (partial.baseBranch !== undefined) {
    current['baseBranch'] = partial.baseBranch;
  }
  if (partial.assetVcs !== undefined) {
    current['assetVcs'] = partial.assetVcs;
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
