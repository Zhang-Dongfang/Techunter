import chalk from 'chalk';
import ora from 'ora';
import { getConfig } from '../lib/config.js';
import { createTask } from '../lib/github.js';

export async function addCommand(title: string, options: { body?: string }): Promise<void> {
  if (!title.trim()) {
    console.error(chalk.red('Error: task title cannot be empty'));
    process.exit(1);
  }

  const config = getConfig();
  const spinner = ora(`Creating task: "${title}"...`).start();

  try {
    const issue = await createTask(config, title, options.body);
    spinner.succeed(`Task created: #${issue.number}`);
    console.log(chalk.cyan(`  ${issue.htmlUrl}`));
    console.log(chalk.dim(`\nClaim it with: tch claim ${issue.number}`));
  } catch (err) {
    spinner.fail('Failed to create task');
    throw err;
  }
}
