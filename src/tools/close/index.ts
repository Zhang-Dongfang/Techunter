import { select } from '@inquirer/prompts';
import ora from 'ora';
import type { TechunterConfig } from '../../types.js';
import { listTasks, closeTask } from '../../lib/github.js';
import { getStatus } from '../../lib/display.js';

export const definition = {
  type: 'function',
  function: {
    name: 'close',
    description: 'Close a task (GitHub Issue). Equivalent to /close. Shows a task picker if issue_number is not provided.',
    parameters: {
      type: 'object',
      properties: {
        issue_number: { type: 'number', description: 'Issue number to close (optional — user will be prompted if omitted)' },
      },
      required: [],
    },
  },
} as const;

export async function run(config: TechunterConfig, opts: { issue_number?: number } = {}): Promise<string> {
  let issueNumber = opts.issue_number;
  if (!issueNumber) {
    let tasks;
    try {
      tasks = await listTasks(config);
    } catch (err) {
      return `Error loading tasks: ${(err as Error).message}`;
    }
    if (tasks.length === 0) return 'No tasks found.';
    try {
      issueNumber = await select({
        message: 'Select task to close:',
        choices: tasks.map((t) => ({ name: `#${t.number}  [${getStatus(t)}]  ${t.title}`, value: t.number })),
      });
    } catch {
      return 'Cancelled.';
    }
  }
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
  const spinner = ora(`Closing #${issueNumber}…`).start();
  try {
    await closeTask(config, issueNumber);
    spinner.stop();
    return `Task #${issueNumber} closed.`;
  } catch (err) {
    spinner.stop();
    return `Error: ${(err as Error).message}`;
  }
}

export const execute = (input: Record<string, unknown>, config: TechunterConfig) =>
  run(config, { issue_number: input['issue_number'] as number | undefined });
