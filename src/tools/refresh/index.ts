import type { TechunterConfig } from '../../types.js';
import { printTaskList, getStatus } from '../../lib/display.js';

export const definition = {
  type: 'function',
  function: {
    name: 'refresh',
    description: 'Reload and display the full task list. Equivalent to /refresh.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
} as const;

export async function run(config: TechunterConfig): Promise<string> {
  const tasks = await printTaskList(config);
  if (tasks.length === 0) return 'No tasks found.';
  const lines = tasks.map((t) => {
    const status = getStatus(t);
    const assignee = t.assignee ? `@${t.assignee}` : '—';
    return `#${t.number}  [${status}]  ${assignee}  ${t.title}`;
  });
  return `Tasks (${tasks.length}):\n${lines.join('\n')}`;
}

export const execute = (_input: Record<string, unknown>, config: TechunterConfig) => run(config);
export const terminal = true;
