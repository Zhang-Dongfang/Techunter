import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TechunterConfig } from '../../types.js';

export const definition = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read the full contents of a specific file in the project.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root' },
      },
      required: ['path'],
    },
  },
} as const;

export async function execute(input: Record<string, unknown>, _config: TechunterConfig): Promise<string> {
  const filePath = input['path'] as string;
  try {
    const fullPath = path.join(process.cwd(), filePath);
    const content = await readFile(fullPath, 'utf-8');
    return content.length > 15_000 ? content.slice(0, 15_000) + '\n\n... (truncated)' : content;
  } catch (err) {
    return `Error reading file: ${(err as Error).message}`;
  }
}
