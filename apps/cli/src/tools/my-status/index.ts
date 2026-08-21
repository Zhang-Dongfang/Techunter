import ora from 'ora';
import type { TechunterConfig } from '../../types.js';
import { getAuthenticatedUser, listMyTasks } from '../../lib/github.js';
import { getStatus } from '../../lib/display.js';

export const definition = {
  type: 'function',
  function: {
    name: 'my_status',
    description: 'Show all tasks currently assigned to the authenticated GitHub user. Equivalent to /status.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
} as const;

export async function run(_input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const spinner = ora('Fetching your tasks…').start();
  try {
    const me = await getAuthenticatedUser(config);
    const tasks = await listMyTasks(config, me);
    spinner.stop();
    if (tasks.length === 0) return `No tasks assigned to @${me}.`;
    const lines = tasks.map((t) => `  #${t.number}  [${getStatus(t)}]  ${t.title}`);
    return `Tasks assigned to @${me}:\n${lines.join('\n')}`;
  } catch (err) {
    spinner.stop();
    return `Error: ${(err as Error).message}`;
  }
}

export const execute = run;
export const terminal = true;
