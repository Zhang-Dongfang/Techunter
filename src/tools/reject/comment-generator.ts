import type { TechunterConfig } from '../../types.js';
import { runSubAgentLoop } from '../../lib/sub-agent.js';
import { REJECTION_FORMAT } from './prompts.js';

export async function generateRejectionComment(
  config: TechunterConfig,
  issueNumber: number,
  userFeedback: string
): Promise<string> {
  return runSubAgentLoop(
    config,
    'You are a senior engineer writing a structured code review rejection comment. ' +
      'Use get_task to read the acceptance criteria, get_diff or grep_code to inspect the implementation, ' +
      'and get_comments to see prior discussion. Then write the rejection comment.\n\n' + REJECTION_FORMAT,
    `Write a rejection comment for issue #${issueNumber}.\nReviewer feedback: ${userFeedback}`,
    ['get_task', 'get_comments', 'get_diff', 'grep_code']
  );
}
