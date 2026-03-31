import chalk from 'chalk';
import type { TechunterConfig, GitHubIssue } from '../types.js';
import { listTasks, getAuthenticatedUser, listMyTasks, extractTargetBranch } from './github.js';
import { renderMarkdown } from './markdown.js';
import { getCurrentBranch, makeTaskBranchName, isTaskBranch } from './git.js';

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

/** Extract parent issue number from a task branch name like task-5-add-login */
function parentIssueFromBranch(branch: string): number | null {
  if (!isTaskBranch(branch)) return null;
  const match = branch.match(/^task-(\d+)-/);
  return match ? parseInt(match[1], 10) : null;
}

export function getParentIssueNumber(issue: GitHubIssue): number | null {
  const target = extractTargetBranch(issue.body);
  if (!target) return null;
  return parentIssueFromBranch(target);
}

export function printTaskDetail(issue: GitHubIssue): void {
  const divider = chalk.dim('─'.repeat(70));
  const parentNum = getParentIssueNumber(issue);
  console.log('\n' + divider);
  console.log(
    chalk.bold(` #${issue.number}`) +
    '  ' + colorStatus(getStatus(issue)) +
    '  ' + chalk.dim(issue.assignee ? `@${issue.assignee}` : '—') +
    (parentNum ? chalk.dim(`  sub-task of #${parentNum}`) : '')
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
      // Build parent→children map
      const taskMap = new Map(tasks.map((t) => [t.number, t]));
      const childrenOf = new Map<number | null, GitHubIssue[]>();

      for (const t of tasks) {
        const parentNum = getParentIssueNumber(t);
        // Only treat as child if parent is in the current list; otherwise show as root
        const key = (parentNum !== null && taskMap.has(parentNum)) ? parentNum : null;
        if (!childrenOf.has(key)) childrenOf.set(key, []);
        childrenOf.get(key)!.push(t);
      }

      function printTask(t: GitHubIssue, prefix: string, isLast: boolean): void {
        const num = `#${t.number}`.padEnd(5);
        const status = colorStatus(getStatus(t));
        const assignee = (t.assignee ? `@${t.assignee}` : '—').padEnd(16);
        const maxTitle = 36 - prefix.length;
        const title = t.title.length > maxTitle ? t.title.slice(0, maxTitle - 3) + '...' : t.title;
        console.log(` ${num}${status}${assignee}${chalk.dim(prefix)}${title}`);

        const children = childrenOf.get(t.number) ?? [];
        for (let i = 0; i < children.length; i++) {
          printTask(children[i]!, prefix + (isLast ? '  ' : '│ '), i === children.length - 1);
        }
      }

      const roots = childrenOf.get(null) ?? [];
      for (let i = 0; i < roots.length; i++) {
        printTask(roots[i]!, i === roots.length - 1 ? '└─ ' : '├─ ', i === roots.length - 1);
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
      const parentNum = getParentIssueNumber(t);
      const parentTag = parentNum ? chalk.dim(` (sub of #${parentNum})`) : '';
      const maxTitle = parentNum ? 34 : 46;
      const title = t.title.length > maxTitle ? t.title.slice(0, maxTitle - 3) + '...' : t.title;
      console.log(` ${num}${status}${title}${parentTag}`);
    }
    console.log(divider);

    // Warn if any task was rejected
    const rejectedTasks = tasks.filter((t) => t.labels.includes(LABEL_CHANGES_NEEDED));
    if (rejectedTasks.length > 0) {
      let currentBranch = '';
      try { currentBranch = await getCurrentBranch(); } catch { /* ignore */ }

      console.log('');
      for (const t of rejectedTasks) {
        const taskBranch = t.assignee ? makeTaskBranchName(t.number, t.assignee) : `task-${t.number}`;
        const onCorrectBranch = currentBranch === taskBranch;
        console.log(
          chalk.red.bold('  ⚠ Changes requested') +
          chalk.red(` on #${t.number} "${t.title}"`)
        );
        if (!onCorrectBranch) {
          console.log(
            chalk.dim('    Switch branch: ') +
            chalk.cyan(`git checkout ${taskBranch}`)
          );
        }
      }
      console.log('');
    }
  } catch {
    // silently skip if GitHub is unreachable
  }
}
