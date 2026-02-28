import chalk from 'chalk';
import ora from 'ora';
import { getConfig } from '../lib/config.js';
import { listTasks } from '../lib/github.js';
import type { GitHubIssue } from '../types.js';

function labelColor(labels: string[]): (text: string) => string {
  if (labels.includes('techunter:in-review')) return chalk.blue;
  if (labels.includes('techunter:claimed')) return chalk.yellow;
  if (labels.includes('techunter:available')) return chalk.green;
  return chalk.white;
}

function statusText(labels: string[]): string {
  if (labels.includes('techunter:in-review')) return 'in-review';
  if (labels.includes('techunter:claimed')) return 'claimed';
  if (labels.includes('techunter:available')) return 'available';
  return 'unknown';
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

function renderTable(issues: GitHubIssue[]): void {
  if (issues.length === 0) {
    console.log(chalk.dim('No tasks found. Create one with: tch add "task title"'));
    return;
  }

  const numWidth = 4;
  const statusWidth = 12;
  const assigneeWidth = 16;
  const titleWidth = 50;

  const header = [
    chalk.bold('#'.padEnd(numWidth)),
    chalk.bold('Status'.padEnd(statusWidth)),
    chalk.bold('Assignee'.padEnd(assigneeWidth)),
    chalk.bold('Title'),
  ].join('  ');

  const separator = '-'.repeat(numWidth + statusWidth + assigneeWidth + titleWidth + 6);

  console.log('\n' + header);
  console.log(chalk.dim(separator));

  for (const issue of issues) {
    const colorFn = labelColor(issue.labels);
    const status = statusText(issue.labels);
    const assignee = issue.assignee ?? '—';

    const row = [
      colorFn(String(issue.number).padEnd(numWidth)),
      colorFn(status.padEnd(statusWidth)),
      chalk.dim(truncate(assignee, assigneeWidth).padEnd(assigneeWidth)),
      truncate(issue.title, titleWidth),
    ].join('  ');

    console.log(row);
  }

  console.log();
}

export async function tasksCommand(): Promise<void> {
  const config = getConfig();

  const spinner = ora('Fetching tasks...').start();

  try {
    const issues = await listTasks(config);
    spinner.stop();
    renderTable(issues);
  } catch (err) {
    spinner.fail('Failed to fetch tasks');
    throw err;
  }
}
