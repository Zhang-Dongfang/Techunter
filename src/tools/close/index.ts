import { select } from '@inquirer/prompts';
import ora from 'ora';
import type { TechunterConfig } from '../../types.js';
import { listTasks, closeTask, getTask, getAuthenticatedUser } from '../../lib/github.js';
import { getConfig, setConfig } from '../../lib/config.js';
import { getStatus } from '../../lib/display.js';

function clearActiveTaskIfMatches(issueNumber: number): void {
  const taskState = getConfig().taskState;
  if (taskState?.activeIssueNumber !== issueNumber) return;
  setConfig({ taskState: { activeIssueNumber: undefined, baseCommit: undefined, activeBranch: undefined } });
}

function getCloseError(issue: Awaited<ReturnType<typeof getTask>>, username: string): string | null {
  const status = getStatus(issue);
  if (status === 'in-review') {
    return `Task #${issue.number} is in review. Use /accept or /reject instead of /close.`;
  }

  if (issue.author === username || issue.assignee === username) {
    return null;
  }

  if (issue.author && issue.assignee) {
    return `Permission denied: only the task author (@${issue.author}) or assignee (@${issue.assignee}) can close task #${issue.number}.`;
  }
  if (issue.author) {
    return `Permission denied: only the task author (@${issue.author}) can close task #${issue.number}.`;
  }
  if (issue.assignee) {
    return `Permission denied: only the assignee (@${issue.assignee}) can close task #${issue.number}.`;
  }
  return `Permission denied: task #${issue.number} has no author or assignee information.`;
}

export const definition = {
  type: 'function',
  function: {
    name: 'close',
    description: 'Close a task (GitHub Issue). Equivalent to /close.',
    parameters: {
      type: 'object',
      properties: {
        issue_number: { type: 'number', description: 'Issue number to close.' },
      },
      required: ['issue_number'],
    },
  },
} as const;

export async function run(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const me = await getAuthenticatedUser(config);
  let issueNumber = input['issue_number'] as number | undefined;

  if (!issueNumber) {
    let tasks;
    try {
      tasks = await listTasks(config);
    } catch (err) {
      return `Error loading tasks: ${(err as Error).message}`;
    }

    const closableTasks = tasks.filter((task) => !getCloseError(task, me));
    if (closableTasks.length === 0) return 'No tasks you can close right now.';

    try {
      issueNumber = await select({
        message: 'Select task to close:',
        choices: closableTasks.map((task) => ({
          name: `#${task.number}  [${getStatus(task)}]  ${task.title}`,
          value: task.number,
        })),
      });
    } catch {
      return 'Cancelled.';
    }
  }

  let issue: Awaited<ReturnType<typeof getTask>>;
  try {
    issue = await getTask(config, issueNumber);
  } catch (err) {
    return `Error loading task: ${(err as Error).message}`;
  }

  const closeError = getCloseError(issue, me);
  if (closeError) return closeError;

  let confirmed: boolean;
  try {
    confirmed = await select({
      message: `Close task #${issueNumber}?`,
      choices: [
        { name: 'Yes, close it', value: true },
        { name: 'No, cancel', value: false },
      ],
    });
  } catch {
    return 'Cancelled.';
  }
  if (!confirmed) return 'Cancelled.';

  const spinner = ora(`Closing #${issueNumber}...`).start();
  try {
    await closeTask(config, issueNumber);
    clearActiveTaskIfMatches(issueNumber);
    spinner.stop();
    return `Task #${issueNumber} closed.`;
  } catch (err) {
    spinner.stop();
    return `Error: ${(err as Error).message}`;
  }
}

export async function execute(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const issueNumber = input['issue_number'] as number;
  const [me, issue] = await Promise.all([
    getAuthenticatedUser(config),
    getTask(config, issueNumber),
  ]);

  const closeError = getCloseError(issue, me);
  if (closeError) return closeError;

  const spinner = ora(`Closing #${issueNumber}...`).start();
  try {
    await closeTask(config, issueNumber);
    clearActiveTaskIfMatches(issueNumber);
    spinner.stop();
    return `Task #${issueNumber} closed.`;
  } catch (err) {
    spinner.stop();
    return `Error: ${(err as Error).message}`;
  }
}

export const terminal = true;
