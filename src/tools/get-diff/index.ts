import ora from 'ora';
import type { TechunterConfig } from '../../types.js';
import { getDiff } from '../../lib/git.js';

export const definition = {
  type: 'function',
  function: {
    name: 'get_diff',
    description: 'Get the current git diff: changed files, diff vs HEAD, and any unpushed commits.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
} as const;

export async function execute(_input: Record<string, unknown>, _config: TechunterConfig): Promise<string> {
  const spinner = ora('Reading git diff...').start();
  try {
    const diff = await getDiff(_config.github.baseBranch);
    spinner.stop();
    return diff;
  } catch (err) {
    spinner.stop();
    throw err;
  }
}
