import { select, input as promptInput } from '@inquirer/prompts';
import ora from 'ora';
import type { TechunterConfig } from '../../types.js';
import { listTasks, getTask, editTask, stripTaskMetadata } from '../../lib/github.js';
import { getStatus } from '../../lib/display.js';

export const definition = {
  type: 'function',
  function: {
    name: 'edit_task',
    description: 'Edit the title and/or body of an existing task (GitHub Issue). Equivalent to /edit.',
    parameters: {
      type: 'object',
      properties: {
        issue_number: { type: 'number', description: 'Issue number to edit.' },
        title: { type: 'string', description: 'New title.' },
        body: { type: 'string', description: 'New body/description.' },
      },
      required: ['issue_number', 'title', 'body'],
    },
  },
} as const;

export async function run(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  let issueNumber = input['issue_number'] as number | undefined;

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
        message: 'Select task to edit:',
        choices: tasks.map((t) => ({ name: `#${t.number}  [${getStatus(t)}]  ${t.title}`, value: t.number })),
      });
    } catch {
      return 'Cancelled.';
    }
  }

  let issue;
  try {
    issue = await getTask(config, issueNumber);
  } catch (err) {
    return `Error loading task: ${(err as Error).message}`;
  }

  let title: string;
  let body: string;
  const editableBody = stripTaskMetadata(issue.body ?? '');
  try {
    title = await promptInput({
      message: 'Title:',
      default: issue.title,
    });
    body = await promptInput({
      message: 'Description:',
      default: editableBody,
    });
  } catch {
    return 'Cancelled.';
  }

  if (title.trim() === issue.title && body.trim() === editableBody) {
    return 'No changes made.';
  }

  const spinner = ora(`Updating #${issueNumber}…`).start();
  try {
    await editTask(config, issueNumber, title.trim() || issue.title, body.trim());
    spinner.stop();
    return `Task #${issueNumber} updated.`;
  } catch (err) {
    spinner.stop();
    return `Error: ${(err as Error).message}`;
  }
}

export async function execute(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const issueNumber = input['issue_number'] as number;
  const title = input['title'] as string;
  const body = input['body'] as string;
  const spinner = ora(`Updating #${issueNumber}…`).start();
  try {
    await editTask(config, issueNumber, title, body);
    spinner.stop();
    return `Task #${issueNumber} updated.`;
  } catch (err) {
    spinner.stop();
    return `Error: ${(err as Error).message}`;
  }
}

export const terminal = true;
