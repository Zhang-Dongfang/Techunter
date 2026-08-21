import type { TechunterConfig } from '../../types.js';
import { getCurrentBranch, parseIssueNumberFromBranch } from '../../lib/git.js';
import { getTask, getIssueNumberFromBranch } from '../../lib/github.js';
import { getConfig } from '../../lib/config.js';
import { launchClaudeCode } from '../../lib/launch.js';

export const definition = {
  type: 'function',
  function: {
    name: 'open_code',
    description: 'Launch Claude Code for the current task branch. Equivalent to /code.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
} as const;

export async function run(_input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  let branch: string;
  try {
    branch = await getCurrentBranch();
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }

  const taskState = getConfig().taskState;
  let issueNum = parseIssueNumberFromBranch(branch)
    ?? (await getIssueNumberFromBranch(config, branch))?.issueNumber
    ?? (
      taskState?.activeBranch === branch
        ? taskState.activeIssueNumber
        : undefined
    );
  if (!issueNum) return `No active task found (current branch: ${branch}).`;

  let issue;
  try {
    issue = await getTask(config, issueNum);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
  await launchClaudeCode(issue, branch);
  return 'Claude Code session ended.';
}

export const execute = run;
export const terminal = true;
