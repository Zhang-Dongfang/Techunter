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
    case 'available':
      return chalk.green(padded);
    case 'claimed':
      return chalk.yellow(padded);
    case 'in-review':
      return chalk.blue(padded);
    case 'changes-needed':
      return chalk.red(padded);
    default:
      return padded;
  }
}

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
  const divider = chalk.dim('-'.repeat(70));
  const parentNum = getParentIssueNumber(issue);
  console.log(`\n${divider}`);
  console.log(
    `${chalk.bold(`#${issue.number}`)}  ${colorStatus(getStatus(issue))}  ` +
    `${chalk.dim(issue.assignee ? `@${issue.assignee}` : '-')}` +
    (parentNum ? chalk.dim(`  sub-task of #${parentNum}`) : '')
  );
  console.log(chalk.bold(`\n${issue.title}`));
  if (issue.body) {
    console.log('');
    console.log(renderMarkdown(issue.body));
  }
  console.log(`\n${chalk.dim(issue.htmlUrl)}`);
  console.log(`${divider}\n`);
}

export async function printTaskList(config: TechunterConfig): Promise<GitHubIssue[]> {
  try {
    const tasks = await listTasks(config);
    const divider = chalk.dim('-'.repeat(70));
    console.log('');
    console.log(chalk.dim(` ${'#'.padEnd(5)}${'Status'.padEnd(14)}${'Assignee'.padEnd(16)}Title`));
    console.log(divider);

    if (tasks.length === 0) {
      console.log(chalk.dim('  (no tasks)'));
    } else {
      const taskMap = new Map(tasks.map((task) => [task.number, task]));
      const childrenOf = new Map<number | null, GitHubIssue[]>();
      const visited = new Set<number>();

      for (const task of tasks) {
        const parentNum = getParentIssueNumber(task);
        const key = parentNum !== null && taskMap.has(parentNum) ? parentNum : null;
        if (!childrenOf.has(key)) childrenOf.set(key, []);
        childrenOf.get(key)!.push(task);
      }

      function printTask(task: GitHubIssue, indent: string, connector: string, isLast: boolean): void {
        if (visited.has(task.number)) return;
        visited.add(task.number);

        const num = `#${task.number}`.padEnd(5);
        const status = colorStatus(getStatus(task));
        const assignee = (task.assignee ? `@${task.assignee}` : '-').padEnd(16);
        const fullPrefix = `${indent}${connector}`;
        const maxTitle = Math.max(12, 36 - fullPrefix.length);
        const title = task.title.length > maxTitle ? `${task.title.slice(0, maxTitle - 3)}...` : task.title;
        console.log(` ${num}${status}${assignee}${chalk.dim(fullPrefix)}${title}`);

        const children = (childrenOf.get(task.number) ?? []).filter((child) => !visited.has(child.number));
        const childIndent = `${indent}${isLast ? '   ' : '|  '}`;
        for (let i = 0; i < children.length; i++) {
          const childIsLast = i === children.length - 1;
          printTask(children[i]!, childIndent, childIsLast ? '\\-- ' : '|-- ', childIsLast);
        }
      }

      const roots = childrenOf.get(null) ?? [];
      for (let i = 0; i < roots.length; i++) {
        const isLast = i === roots.length - 1;
        printTask(roots[i]!, '', isLast ? '\\-- ' : '|-- ', isLast);
      }

      const remaining = tasks.filter((task) => !visited.has(task.number));
      if (remaining.length > 0) {
        console.log(chalk.yellow('  Warning: task hierarchy contains orphaned or cyclic links; showing remaining tasks at root.'));
        for (let i = 0; i < remaining.length; i++) {
          const isLast = i === remaining.length - 1;
          printTask(remaining[i]!, '', isLast ? '\\-- ' : '|-- ', isLast);
        }
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

    const divider = chalk.dim('-'.repeat(70));
    console.log('');
    console.log(chalk.dim(` ${'#'.padEnd(5)}${'Status'.padEnd(14)}My Tasks  @${me}`));
    console.log(divider);
    for (const task of tasks) {
      const num = `#${task.number}`.padEnd(5);
      const status = colorStatus(getStatus(task));
      const parentNum = getParentIssueNumber(task);
      const parentTag = parentNum ? chalk.dim(` (sub of #${parentNum})`) : '';
      const maxTitle = parentNum ? 34 : 46;
      const title = task.title.length > maxTitle ? `${task.title.slice(0, maxTitle - 3)}...` : task.title;
      console.log(` ${num}${status}${title}${parentTag}`);
    }
    console.log(divider);

    const rejectedTasks = tasks.filter((task) => task.labels.includes(LABEL_CHANGES_NEEDED));
    if (rejectedTasks.length > 0) {
      let currentBranch = '';
      try {
        currentBranch = await getCurrentBranch();
      } catch {
        // ignore
      }

      console.log('');
      for (const task of rejectedTasks) {
        const taskBranch = task.assignee ? makeTaskBranchName(task.number, task.assignee) : `task-${task.number}`;
        const onCorrectBranch = currentBranch === taskBranch;
        console.log(chalk.red.bold('  ! Changes requested') + chalk.red(` on #${task.number} "${task.title}"`));
        if (!onCorrectBranch) {
          console.log(chalk.dim('    Switch branch: ') + chalk.cyan(`git checkout ${taskBranch}`));
        }
      }
      console.log('');
    }
  } catch {
    // silently skip if GitHub is unreachable
  }
}
