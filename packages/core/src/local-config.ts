import Conf from 'conf';

import type { AiConfig } from './types.js';

export interface LocalTechunterConfig extends AiConfig {
  githubToken?: string;
  githubClientId?: string;
  github?: { owner?: string; repo?: string };
  baseBranch?: string;
  [key: string]: unknown;
}

export function getTechunterConfigStore<T extends Record<string, any> = LocalTechunterConfig>(): Conf<T> {
  return new Conf<T>({ projectName: 'techunter', defaults: {} as T });
}

export function readLocalTechunterConfig(): { path: string; config: LocalTechunterConfig | null } {
  const store = getTechunterConfigStore<LocalTechunterConfig>();
  const value = store.store;
  return { path: store.path, config: Object.keys(value).length > 0 ? value : null };
}
