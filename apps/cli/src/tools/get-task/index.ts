import type { TechunterConfig } from '../../types.js';
import { getTask } from '../../lib/github.js';

export const definition = {
  type: 'function',
  function: {
    name: 'get_task',
    description: 'Get full details of a specific GitHub issue: title, body, status, assignee.',
    parameters: {
      type: 'object',
      properties: {
        issue_number: { type: 'number', description: 'GitHub issue number' },
      },
      required: ['issue_number'],
    },
  },
} as const;

export async function execute(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const issue = await getTask(config, input['issue_number'] as number);
  const status = issue.labels.find((l) => l.startsWith('techunter:'))?.replace('techunter:', '') ?? 'unknown';
  const assignee = issue.assignee ? `@${issue.assignee}` : '—';
  const lines = [
    `#${issue.number}  [${status}]  ${assignee}`,
    `Title: ${issue.title}`,
    `URL: ${issue.htmlUrl}`,
  ];
  if (issue.body) lines.push(`\n${issue.body}`);
  return lines.join('\n');
}
