import type { TechunterConfig } from '../../types.js';
import { listFilesTool } from '@techunter/core';

export const definition = {
  type: 'function',
  function: {
    name: 'list_files',
    description: 'List file paths in the project. Use this first to orient yourself before searching or reading.',
    parameters: {
      type: 'object',
      properties: {
        glob: { type: 'string', description: 'Glob pattern, for example src/**/*.ts. Defaults to all text files.' },
      },
      required: [],
    },
  },
} as const;

export function execute(input: Record<string, unknown>, _config: TechunterConfig): Promise<string> {
  return listFilesTool({ root: process.cwd() }, input);
}
