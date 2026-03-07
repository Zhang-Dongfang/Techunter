import chalk from 'chalk';
import type { TechunterConfig, GitHubIssue } from '../types.js';
import { listTasks, getAuthenticatedUser, listMyTasks } from './github.js';
import { renderMarkdown } from './markdown.js';

const LABEL_AVAILABLE = 'techunter:available';
const LABEL_CLAIMED = 'techunter:claimed';
const LABEL_IN_REVIEW = 'techunter:in-review';
const LABEL_CHANGES_NEEDED = 'techunter:changes-needed';

export function getStatus(issue: GitHubIssue): string {
  if (issue.labels.includes(LABEL_CHANGES_NEEDED)) return 'changes-needed';
  if (issue.labels.includes(LABEL_IN_REVIEW)) return 'in-review';
  if (issue.labels.includes(LABEL_CLAIMED)) return 'claimed';
  if (issue.labels.includes(LABEL_AVAILABLE)) return 'available';
  return 'unknown';
}

export function colorStatus(status: string): string {
  const padded = status.padEnd(14);
  switch (status) {
    case 'available':      return chalk.green(padded);
    case 'claimed':        return chalk.yellow(padded);
    case 'in-review':      return chalk.blue(padded);
    case 'changes-needed': return chalk.red(padded);
    default:               return padded;
  }
}

export function printTaskDetail(issue: GitHubIssue): void {
  const divider = chalk.dim('─'.repeat(70));
  console.log('\n' + divider);
  console.log(
    chalk.bold(` #${issue.number}`) +
    '  ' + colorStatus(getStatus(issue)) +
    '  ' + chalk.dim(issue.assignee ? `@${issue.assignee}` : '—')
  );
  console.log(chalk.bold('\n ' + issue.title));
  if (issue.body) {
    console.log('');
    console.log(renderMarkdown(issue.body));
  }
  console.log('\n ' + chalk.dim(issue.htmlUrl));
  console.log(divider + '\n');
}

export async function printTaskList(config: TechunterConfig): Promise<GitHubIssue[]> {
  try {
    const tasks = await listTasks(config);
    const divider = chalk.dim('─'.repeat(70));
    console.log('');
    console.log(chalk.dim(' ' + '#'.padEnd(5) + 'Status'.padEnd(14) + 'Assignee'.padEnd(16) + 'Title'));
    console.log(divider);
    if (tasks.length === 0) {
      console.log(chalk.dim('  (no tasks)'));
    } else {
      for (const t of tasks) {
        const num = `#${t.number}`.padEnd(5);
        const status = colorStatus(getStatus(t));
        const assignee = (t.assignee ? `@${t.assignee}` : '—').padEnd(16);
        const title = t.title.length > 36 ? t.title.slice(0, 33) + '...' : t.title;
        console.log(` ${num}${status}${assignee}${title}`);
      }
    }
    console.log(divider);
    return tasks;
  } catch (err) {
    console.log(chalk.yellow(`(Could not load tasks: ${(err as Error).message})`));
    return [];
  }
}

export async function printMyTasks(config: TechunterConfig): Promise<void> {
  try {
    const me = await getAuthenticatedUser(config);
    const tasks = await listMyTasks(config, me);
    if (tasks.length === 0) return;
    const divider = chalk.dim('─'.repeat(70));
    console.log('');
    console.log(chalk.dim(' ' + '#'.padEnd(5) + 'Status'.padEnd(14) + `My Tasks  @${me}`));
    console.log(divider);
    for (const t of tasks) {
      const num = `#${t.number}`.padEnd(5);
      const status = colorStatus(getStatus(t));
      const title = t.title.length > 46 ? t.title.slice(0, 43) + '...' : t.title;
      console.log(` ${num}${status}${title}`);
    }
    console.log(divider);
  } catch {
    // silently skip if GitHub is unreachable
  }
}
