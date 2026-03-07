import ora from 'ora';
import type { TechunterConfig } from '../../types.js';
import { getAuthenticatedUser, listTasksForReview } from '../../lib/github.js';

export const definition = {
  type: 'function',
  function: {
    name: 'review',
    description: 'List tasks waiting for your review (submitted by others, created by you). Equivalent to /review.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
} as const;

export async function run(config: TechunterConfig): Promise<string> {
  const spinner = ora('Loading tasks for review…').start();
  try {
    const me = await getAuthenticatedUser(config);
    const tasks = await listTasksForReview(config, me);
    spinner.stop();
    if (tasks.length === 0) return `No tasks pending review for @${me}.`;
    const lines = tasks.map((t) => `  #${t.number}  [in-review]  @${t.assignee ?? '—'}  ${t.title}`);
    return `Tasks pending review (created by @${me}):\n${lines.join('\n')}`;
  } catch (err) {
    spinner.stop();
    return `Error: ${(err as Error).message}`;
  }
}

export const execute = (_input: Record<string, unknown>, config: TechunterConfig) => run(config);
