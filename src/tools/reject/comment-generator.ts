import type { TechunterConfig, GitHubIssue } from '../../types.js';
import { createClient, MODEL } from '../../lib/client.js';
import { REJECTION_FORMAT } from './prompts.js';

export async function generateRejectionComment(
  config: TechunterConfig,
  issue: GitHubIssue,
  userFeedback: string
): Promise<string> {
  const client = createClient(config);

  const res = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: `You are a senior engineer writing a structured code review rejection comment.\n\n${REJECTION_FORMAT}`,
      },
      {
        role: 'user',
        content:
          `Task #${issue.number}: ${issue.title}\n\n` +
          `Acceptance Criteria:\n${issue.body ?? '(none)'}\n\n` +
          `Reviewer feedback: ${userFeedback}\n\n` +
          `Write the complete rejection comment.`,
      },
    ],
  });

  return res.choices[0].message.content ?? '';
}
