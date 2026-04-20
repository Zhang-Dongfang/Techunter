import { select } from '@inquirer/prompts';
import ora from 'ora';
import chalk from 'chalk';
import type { TechunterConfig } from '../../types.js';
import {
  listTasks,
  getTask,
  getAuthenticatedUser,
  getTaskBranch,
  getBranchHeadSha,
  moveTask,
} from '../../lib/github.js';
import { getParentIssueNumber, getStatus } from '../../lib/display.js';

export const definition = {
  type: 'function',
  function: {
    name: 'move_task',
    description:
      'Move one of your own published tasks to be a sub-task of another task. ' +
      'Updates the target branch and base commit so executors sync from the new parent HEAD. Equivalent to /move.',
    parameters: {
      type: 'object',
      properties: {
        issue_number: { type: 'number', description: 'Issue number of the task to move.' },
        parent_issue_number: { type: 'number', description: 'Issue number of the new parent task.' },
      },
      required: ['issue_number', 'parent_issue_number'],
    },
  },
} as const;

function getDescendantTaskNumbers(
  tasks: Awaited<ReturnType<typeof listTasks>>,
  issueNumber: number
): Set<number> {
  const childrenOf = new Map<number, number[]>();

  for (const task of tasks) {
    const parentIssueNumber = getParentIssueNumber(task);
    if (parentIssueNumber === null) continue;
    if (!childrenOf.has(parentIssueNumber)) childrenOf.set(parentIssueNumber, []);
    childrenOf.get(parentIssueNumber)!.push(task.number);
  }

  const descendants = new Set<number>();
  const queue = [...(childrenOf.get(issueNumber) ?? [])];
  while (queue.length > 0) {
    const childIssueNumber = queue.shift()!;
    if (descendants.has(childIssueNumber)) continue;
    descendants.add(childIssueNumber);
    queue.push(...(childrenOf.get(childIssueNumber) ?? []));
  }

  return descendants;
}

export async function run(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const me = await getAuthenticatedUser(config);
  const allTasks = await listTasks(config);

  let issueNumber = input['issue_number'] as number | undefined;
  let taskToMove: Awaited<ReturnType<typeof getTask>>;

  if (issueNumber) {
    try {
      taskToMove = await getTask(config, issueNumber);
    } catch (err) {
      return `Error loading task #${issueNumber}: ${(err as Error).message}`;
    }
    if (taskToMove.author !== me) {
      return `Task #${issueNumber} was not authored by you - you can only move your own tasks.`;
    }
  } else {
    const myTasks = allTasks.filter((t) => t.author === me);
    if (myTasks.length === 0) return 'No tasks you authored are available to move.';
    try {
      issueNumber = await select({
        message: 'Select task to move:',
        choices: myTasks.map((t) => ({
          name: `#${t.number}  [${getStatus(t)}]  ${t.title}`,
          value: t.number,
        })),
      });
    } catch {
      return 'Cancelled.';
    }
    taskToMove = myTasks.find((t) => t.number === issueNumber)!;
  }

  const descendantTaskNumbers = getDescendantTaskNumbers(allTasks, taskToMove.number);
  const candidates = allTasks.filter((t) =>
    t.number !== taskToMove.number && !descendantTaskNumbers.has(t.number)
  );

  const resolveSpinner = ora('Finding parent task branches...').start();
  const parents: { task: (typeof candidates)[0]; branch: string }[] = [];
  for (const task of candidates) {
    const branch = await getTaskBranch(config, task.number);
    if (branch) parents.push({ task, branch });
  }
  resolveSpinner.stop();

  if (parents.length === 0) {
    return 'No other tasks with known branches are available as a parent.';
  }

  let parentIssueNumber = input['parent_issue_number'] as number | undefined;
  let chosen: (typeof parents)[0];

  if (parentIssueNumber) {
    if (parentIssueNumber === taskToMove.number) {
      return `Task #${taskToMove.number} cannot be moved under itself.`;
    }
    if (descendantTaskNumbers.has(parentIssueNumber)) {
      return `Task #${taskToMove.number} cannot be moved under #${parentIssueNumber} because that would create a cycle.`;
    }

    const found = parents.find((p) => p.task.number === parentIssueNumber);
    if (!found) {
      return `Task #${parentIssueNumber} is not available as a parent (no branch found or not open).`;
    }
    chosen = found;
  } else {
    try {
      const selectedBranch = await select({
        message: `Move #${taskToMove.number} under which task?`,
        choices: parents.map((p) => ({
          name: `#${p.task.number}  [${getStatus(p.task)}]  ${p.task.title}  ${chalk.dim('->' + p.branch)}`,
          value: p.branch,
        })),
      });
      chosen = parents.find((p) => p.branch === selectedBranch)!;
    } catch {
      return 'Cancelled.';
    }
  }

  const sha = await getBranchHeadSha(config, chosen.branch);
  if (!sha) {
    return `Could not resolve HEAD of branch ${chosen.branch} - does it exist on the remote?`;
  }

  const spinner = ora(`Moving #${taskToMove.number} under #${chosen.task.number}...`).start();
  try {
    await moveTask(config, taskToMove.number, chosen.branch, sha);
    spinner.succeed(
      `Task #${taskToMove.number} moved under #${chosen.task.number} "${chosen.task.title}"\n` +
      `  target: ${chalk.cyan(chosen.branch)}  base: ${chalk.dim(sha.slice(0, 7))}`
    );
    return `Task #${taskToMove.number} moved under #${chosen.task.number} (branch: ${chosen.branch}, base: ${sha.slice(0, 7)})`;
  } catch (err) {
    spinner.fail(`Failed: ${(err as Error).message}`);
    return `Error: ${(err as Error).message}`;
  }
}

export async function execute(input: Record<string, unknown>, config: TechunterConfig): Promise<string> {
  const me = await getAuthenticatedUser(config);
  const issueNumber = input['issue_number'] as number;
  const parentIssueNumber = input['parent_issue_number'] as number;

  const [task, allTasks] = await Promise.all([
    getTask(config, issueNumber),
    listTasks(config),
  ]);

  if (task.author !== me) {
    return `Task #${issueNumber} was not authored by you - you can only move your own tasks.`;
  }
  if (parentIssueNumber === issueNumber) {
    return `Task #${issueNumber} cannot be moved under itself.`;
  }

  const descendantTaskNumbers = getDescendantTaskNumbers(allTasks, issueNumber);
  if (descendantTaskNumbers.has(parentIssueNumber)) {
    return `Task #${issueNumber} cannot be moved under #${parentIssueNumber} because that would create a cycle.`;
  }

  const branch = await getTaskBranch(config, parentIssueNumber);
  if (!branch) return `No branch found for parent task #${parentIssueNumber}.`;

  const sha = await getBranchHeadSha(config, branch);
  if (!sha) return `Could not resolve HEAD of branch ${branch}.`;

  await moveTask(config, issueNumber, branch, sha);
  return `Task #${issueNumber} moved under #${parentIssueNumber} (branch: ${branch}, base: ${sha.slice(0, 7)})`;
}

export const terminal = true;
