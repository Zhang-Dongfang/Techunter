import { input as promptInput } from '@inquirer/prompts';
import ora from 'ora';
import type { TechunterConfig } from '../../types.js';
import { createTask } from '../../lib/github.js';
import { generateGuide } from './guide-generator.js';

export const definition = {
  type: 'function',
  function: {
    name: 'new_task',
    description:
      'Create a new task (GitHub Issue): scans the project, generates a full implementation guide, ' +
      'then creates the issue. Equivalent to /new.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title (optional — user will be prompted if omitted)' },
      },
      required: [],
    },
  },
} as const;

export async function run(config: TechunterConfig, opts: { title?: string } = {}): Promise<string> {
  let title = opts.title;
  if (!title) {
    try {
      title = await promptInput({ message: 'Task title:' });
    } catch {
      return 'Cancelled.';
    }
    if (!title.trim()) return 'Cancelled.';
    title = title.trim();
  }

  const spinner = ora('Scanning project and generating guide…').start();
  let guide: string;
  try {
    guide = await generateGuide(config, title);
    spinner.stop();
  } catch (err) {
    spinner.stop();
    return `Error generating guide: ${(err as Error).message}`;
  }

  const createSpinner = ora(`Creating "${title}"…`).start();
  try {
    const issue = await createTask(config, title, guide);
    createSpinner.stop();
    return `Created #${issue.number} "${issue.title}" — ${issue.htmlUrl}`;
  } catch (err) {
    createSpinner.stop();
    return `Error: ${(err as Error).message}`;
  }
}

export const execute = (input: Record<string, unknown>, config: TechunterConfig) =>
  run(config, { title: input['title'] as string | undefined });
