import ora from 'ora';
import type { TechunterConfig } from '../../types.js';
import { listComments } from '../../lib/github.js';

export const definition = {
  type: 'function',
  function: {
    name: 'get_comments',
    description: 'Get the latest comments on a GitHub issue. Useful for reading rejection feedback.',
    parameters: {
      type: 'object',
      properties: {
        issue_number: { type: 'number', description: 'GitHub issue number' },
        limit: { type: 'number', description: 'Max number of latest comments to return (default 5)' },
      },
      required: ['issue_number'],
    },
  },
} as const;

export async function execute(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const issueNumber = input['issue_number'] as number;
  const limit = (input['limit'] as number | undefined) ?? 5;
  const spinner = ora(`Loading comments for #${issueNumber}...`).start();
  try {
    const comments = await listComments(config, issueNumber, limit);
    spinner.stop();
    if (comments.length === 0) return `No comments on issue #${issueNumber}.`;
    const lines = comments.map((c) => `--- @${c.author} (${c.createdAt.slice(0, 10)}) ---\n${c.body}`);
    return `Latest ${comments.length} comment(s) on #${issueNumber}:\n\n${lines.join('\n\n')}`;
  } catch (err) {
    spinner.stop();
    throw err;
  }
}
