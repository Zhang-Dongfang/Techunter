import type { TechunterConfig } from '../../types.js';
import { getCurrentBranch } from '../../lib/git.js';
import { getTask } from '../../lib/github.js';
import { launchClaudeCode } from '../../lib/launch.js';

export const definition = {
  type: 'function',
  function: {
    name: 'open_code',
    description: 'Launch Claude Code for the current task branch. Equivalent to /code.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
} as const;

export async function run(config: TechunterConfig): Promise<string> {
  let branch: string;
  try {
    branch = await getCurrentBranch();
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
  const match = branch.match(/^task-(\d+)-/);
  if (!match) return `Not on a task branch (current: ${branch}).`;
  const issueNum = parseInt(match[1], 10);
  let issue;
  try {
    issue = await getTask(config, issueNum);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
  await launchClaudeCode(issue, branch);
  return 'Claude Code session ended.';
}

export const execute = (_input: Record<string, unknown>, config: TechunterConfig) => run(config);
export const terminal = true;
