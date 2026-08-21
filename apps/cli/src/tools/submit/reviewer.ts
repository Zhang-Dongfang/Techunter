import type { TechunterConfig, GitHubIssue } from '../../types.js';
import { renderDeliveryReview, reviewDeliveryWithAgent } from '@techunter/core';
import { printToolCall, printToolResult } from '../../lib/agent-ui.js';

export async function reviewChanges(
  config: TechunterConfig,
  issueNumber: number,
  issue: GitHubIssue,
  diff: string
): Promise<string> {
  const acceptanceCriteria = (issue.body ?? '')
    .split('\n')
    .map((line) => line.match(/^\s*-\s*\[[ xX]\]\s*(.+)$/)?.[1]?.trim())
    .filter((line): line is string => Boolean(line));
  const review = await reviewDeliveryWithAgent({
    config,
    title: `#${issueNumber} ${issue.title}`,
    description: issue.body ?? issue.title,
    acceptanceCriteria: acceptanceCriteria.length ? acceptanceCriteria : [issue.title],
    summary: `CLI submission for task #${issueNumber}`,
    testOutput: '',
    diff: diff || '(no changes)',
    repository: { root: process.cwd(), allowCommands: true },
    hooks: {
      onToolCall: (name, input) => printToolCall(name, input),
      onToolResult: (_name, result) => printToolResult(result),
    },
  });
  return renderDeliveryReview(review);
}
