import type { TechunterConfig } from '../../types.js';
import { listTasks } from '../../lib/github.js';

export const definition = {
  type: 'function',
  function: {
    name: 'list_tasks',
    description: 'List all open tasks (GitHub Issues) with their status and assignee. Use this to answer questions about available work, task progress, or who is working on what.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
} as const;

export async function execute(_input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const tasks = await listTasks(config);
  if (tasks.length === 0) return 'No open tasks.';

  return tasks.map((t) => {
    const status = t.labels.find((l) => l.startsWith('techunter:'))?.replace('techunter:', '') ?? 'unknown';
    const assignee = t.assignee ? `@${t.assignee}` : '—';
    return `#${t.number}  [${status}]  ${assignee}  ${t.title}`;
  }).join('\n');
}
