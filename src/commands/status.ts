import chalk from 'chalk';
import ora from 'ora';
import { getConfig } from '../lib/config.js';
import { getAuthenticatedUser, listMyTasks } from '../lib/github.js';
import { makeTaskBranchName } from '../lib/git.js';
import type { GitHubIssue } from '../types.js';

function getStatus(labels: string[]): { text: string; color: (s: string) => string } {
  if (labels.includes('techunter:in-review')) return { text: 'in-review', color: chalk.blue };
  if (labels.includes('techunter:claimed')) return { text: 'claimed', color: chalk.yellow };
  return { text: 'open', color: chalk.green };
}

function renderStatus(issues: GitHubIssue[], username: string): void {
  if (issues.length === 0) {
    console.log(chalk.dim(`No active tasks for @${username}`));
    console.log(chalk.dim('Browse tasks with: tch tasks'));
    return;
  }

  console.log(chalk.bold(`\nActive tasks for @${username}\n`));

  for (const issue of issues) {
    const { text, color } = getStatus(issue.labels);
    const branch = issue.assignee ? makeTaskBranchName(issue.number, issue.assignee) : `task-${issue.number}`;

    console.log(
      color(`#${issue.number}`) + '  ' + chalk.bold(issue.title)
    );
    console.log(
      chalk.dim(`     Status: ${text}  |  Branch: ${branch}`)
    );
    console.log(chalk.dim(`     ${issue.htmlUrl}`));
    console.log();
  }
}

export async function statusCommand(): Promise<void> {
  const config = getConfig();
  const spinner = ora('Fetching your tasks...').start();

  try {
    const me = await getAuthenticatedUser(config);
    const issues = await listMyTasks(config, me);
    spinner.stop();
    renderStatus(issues, me);
  } catch (err) {
    spinner.fail('Failed to fetch status');
    throw err;
  }
}
