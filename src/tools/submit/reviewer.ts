import type { TechunterConfig, GitHubIssue } from '../../types.js';
import { runSubAgentLoop } from '../../lib/sub-agent.js';
import { REVIEWER_SYSTEM_PROMPT } from './prompts.js';

export async function reviewChanges(
  config: TechunterConfig,
  issueNumber: number,
  issue: GitHubIssue,
  diff: string
): Promise<string> {
  return runSubAgentLoop(
    config,
    REVIEWER_SYSTEM_PROMPT,
    `Task #${issueNumber}: ${issue.title}\n\nAcceptance Criteria:\n${issue.body ?? '(none)'}\n\nDiff:\n${diff || '(no changes)'}`,
    ['run_command', 'grep_code', 'get_diff']
  );
}
