import type { TechunterConfig } from '../../types.js';
import { grepCodeTool } from '@techunter/core';

export const definition = {
  type: 'function',
  function: {
    name: 'grep_code',
    description:
      'Search for a pattern across files, or read a specific line range from one file. ' +
      'Use pattern for search mode; use file_glob + start_line + end_line without pattern for read-range mode.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex or plain text to search for.' },
        file_glob: { type: 'string', description: 'Glob restricting files. Defaults to all visible text files.' },
        context_lines: { type: 'number', description: 'Context lines around matches. Default 2.' },
        max_results: { type: 'number', description: 'Maximum matches. Default 50.' },
        start_line: { type: 'number', description: 'First line in read-range mode, 1-based.' },
        end_line: { type: 'number', description: 'Last line in read-range mode, 1-based.' },
      },
      required: [],
    },
  },
} as const;

export function execute(input: Record<string, unknown>, _config: TechunterConfig): Promise<string> {
  return grepCodeTool({ root: process.cwd() }, input);
}
