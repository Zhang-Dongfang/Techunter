import ora from 'ora';

import type { TechunterConfig } from '../../types.js';
import { runCommandTool } from '@techunter/core';

export const definition = {
  type: 'function',
  function: {
    name: 'run_command',
    description: 'Run a build, test, lint, or inspection command in the project root. Commands time out after 60 seconds.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The shell command to run.' } },
      required: ['command'],
    },
  },
} as const;

export async function execute(input: Record<string, unknown>, _config: TechunterConfig): Promise<string> {
  const spinner = ora(`$ ${String(input['command'] ?? '')}`).start();
  try {
    return await runCommandTool({ root: process.cwd(), allowCommands: true }, input);
  } finally {
    spinner.stop();
  }
}
