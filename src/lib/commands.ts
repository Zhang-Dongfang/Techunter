import chalk from 'chalk';
import ora from 'ora';
import { select, input as promptInput } from '@inquirer/prompts';
import { spawn } from 'node:child_process';
import OpenAI from 'openai';
import type { TechunterConfig, GitHubIssue } from '../types.js';
import {
  listTasks,
  getTask,
  createTask,
  closeTask,
  claimTask,
  createPR,
  markInReview,
  postComment,
  rejectTask,
  getAuthenticatedUser,
  listMyTasks,
  listTasksForReview,
  listComments,
  getDefaultBranch,
} from './github.js';
import {
  getCurrentBranch,
  createAndSwitchBranch,
  pushBranch,
  makeBranchName,
  getDiff,
  stageAllAndCommit,
} from './git.js';
import { renderMarkdown } from './markdown.js';

const LABEL_AVAILABLE = 'techunter:available';
const LABEL_CLAIMED = 'techunter:claimed';
const LABEL_IN_REVIEW = 'techunter:in-review';
const LABEL_CHANGES_NEEDED = 'techunter:changes-needed';

// ─── Display helpers ──────────────────────────────────────────────────────────

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

// ─── Command implementations ──────────────────────────────────────────────────

export async function runRefresh(config: TechunterConfig): Promise<string> {
  const tasks = await printTaskList(config);
  if (tasks.length === 0) return 'No tasks found.';
  const lines = tasks.map((t) => {
    const status = getStatus(t);
    const assignee = t.assignee ? `@${t.assignee}` : '—';
    return `#${t.number}  [${status}]  ${assignee}  ${t.title}`;
  });
  return `Tasks (${tasks.length}):\n${lines.join('\n')}`;
}

export async function runNew(
  config: TechunterConfig,
  opts: { title?: string; body?: string } = {}
): Promise<string> {
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
  const spinner = ora(`Creating "${title}"…`).start();
  try {
    const issue = await createTask(config, title, opts.body);
    spinner.stop();
    return `Created #${issue.number} "${issue.title}" — ${issue.htmlUrl}`;
  } catch (err) {
    spinner.stop();
    return `Error: ${(err as Error).message}`;
  }
}

export async function runClose(
  config: TechunterConfig,
  opts: { issue_number?: number } = {}
): Promise<string> {
  let issueNumber = opts.issue_number;
  if (!issueNumber) {
    let tasks: GitHubIssue[];
    try {
      tasks = await listTasks(config);
    } catch (err) {
      return `Error loading tasks: ${(err as Error).message}`;
    }
    if (tasks.length === 0) return 'No tasks found.';
    try {
      issueNumber = await select({
        message: 'Select task to close:',
        choices: tasks.map((t) => ({
          name: `#${t.number}  [${getStatus(t)}]  ${t.title}`,
          value: t.number,
        })),
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

export async function runStatus(config: TechunterConfig): Promise<string> {
  const spinner = ora('Fetching your tasks…').start();
  try {
    const me = await getAuthenticatedUser(config);
    const tasks = await listMyTasks(config, me);
    spinner.stop();
    if (tasks.length === 0) return `No tasks assigned to @${me}.`;
    const lines = tasks.map((t) => `  #${t.number}  [${getStatus(t)}]  ${t.title}`);
    return `Tasks assigned to @${me}:\n${lines.join('\n')}`;
  } catch (err) {
    spinner.stop();
    return `Error: ${(err as Error).message}`;
  }
}

export async function runReview(config: TechunterConfig): Promise<string> {
  const spinner = ora('Loading tasks for review…').start();
  try {
    const me = await getAuthenticatedUser(config);
    const tasks = await listTasksForReview(config, me);
    spinner.stop();
    if (tasks.length === 0) return `No tasks pending review for @${me}.`;
    const lines = tasks.map(
      (t) => `  #${t.number}  [in-review]  @${t.assignee ?? '—'}  ${t.title}`
    );
    return `Tasks pending review (created by @${me}):\n${lines.join('\n')}`;
  } catch (err) {
    spinner.stop();
    return `Error: ${(err as Error).message}`;
  }
}

export async function runSubmit(config: TechunterConfig): Promise<string> {
  const branch = await getCurrentBranch();
  const match = branch.match(/^task-(\d+)-/);
  if (!match) {
    return `Not on a task branch (current: ${branch}). Expected format: task-N-title.`;
  }
  const issueNumber = parseInt(match[1], 10);

  let spinner = ora('Loading task and diff…').start();
  const [issue, defaultBranch, diff] = await Promise.all([
    getTask(config, issueNumber),
    getDefaultBranch(config),
    getDiff(),
  ]);
  spinner.stop();

  // AI review: mini agent loop with run_command + read_file tools
  const reviewSpinner = ora('Reviewing changes…').start();
  let review = '';
  try {
    const client = new OpenAI({ baseURL: 'https://api.ppio.com/openai', apiKey: config.aiApiKey });
    const reviewTools: OpenAI.ChatCompletionTool[] = [
      {
        type: 'function',
        function: {
          name: 'run_command',
          description: 'Run a shell command (e.g. tests, lint) to verify the changes.',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file to inspect the implementation.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Path relative to project root' } },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_diff',
          description: 'Get the full git diff of all changes on this branch.',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
    ];

    const reviewMessages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content:
          'You are a concise code reviewer. Use run_command to run tests/lint if needed, ' +
          'and read_file to inspect specific files. ' +
          'Then output your review: for each acceptance criterion mark ✅ met or ❌ not met with a one-line reason. ' +
          'End with an overall verdict line: Ready to submit / Not ready. ' +
          'Reply in the same language as the task.',
      },
      {
        role: 'user',
        content: `Task #${issueNumber}: ${issue.title}\n\nAcceptance Criteria:\n${issue.body ?? '(none)'}\n\nDiff:\n${diff || '(no changes)'}`,
      },
    ];

    for (;;) {
      const res = await client.chat.completions.create({
        model: 'zai-org/glm-5',
        tools: reviewTools,
        messages: reviewMessages,
      });
      const choice = res.choices[0];
      reviewMessages.push({
        role: 'assistant',
        content: choice.message.content ?? null,
        ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
      });

      if (choice.finish_reason === 'stop') {
        review = choice.message.content ?? '';
        break;
      }

      if (choice.finish_reason === 'tool_calls') {
        const cwd = process.cwd();
        for (const tc of choice.message.tool_calls ?? []) {
          const args = JSON.parse(tc.function.arguments) as Record<string, string>;
          let result = '';
          if (tc.function.name === 'run_command') {
            try {
              const { exec } = await import('node:child_process');
              const { promisify } = await import('node:util');
              const execAsync = promisify(exec);
              const { stdout, stderr } = await execAsync(args['command']!, { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 });
              result = [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)';
            } catch (e) {
              const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
              result = `Exit ${err.code ?? 1}:\n${[err.stdout, err.stderr].filter(Boolean).join('\n') || err.message}`;
            }
          } else if (tc.function.name === 'get_diff') {
            try {
              result = await getDiff();
            } catch (e) {
              result = `Error: ${(e as Error).message}`;
            }
          } else if (tc.function.name === 'read_file') {
            try {
              const { readFile } = await import('node:fs/promises');
              const fullPath = (await import('node:path')).default.join(cwd, args['path']!);
              const content = await readFile(fullPath, 'utf-8');
              result = content.length > 10_000 ? content.slice(0, 10_000) + '\n... (truncated)' : content;
            } catch (e) {
              result = `Error: ${(e as Error).message}`;
            }
          }
          reviewMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
      }
    }
  } catch (err) {
    review = `(Review failed: ${(err as Error).message})`;
  }
  reviewSpinner.stop();

  const divider = chalk.dim('─'.repeat(70));
  console.log('\n' + divider);
  console.log(chalk.bold(`  Review — task #${issueNumber} "${issue.title}"`));
  console.log(divider);
  console.log(renderMarkdown(review));
  console.log(divider + '\n');

  let shouldProceed: boolean;
  try {
    shouldProceed = await select({
      message: `Submit task #${issueNumber}?`,
      choices: [
        { name: 'Yes, submit', value: true },
        { name: 'No, not ready yet', value: false },
      ],
    });
  } catch {
    return 'Submit cancelled.';
  }
  if (!shouldProceed) return 'Submit cancelled by user.';

  let commitMessage: string;
  try {
    commitMessage = await promptInput({
      message: 'Commit message:',
      default: `complete: ${issue.title}`,
    });
  } catch {
    return 'Submit cancelled.';
  }
  if (!commitMessage.trim()) return 'Submit cancelled.';

  spinner = ora('Committing and pushing…').start();
  try {
    await stageAllAndCommit(commitMessage.trim());
    spinner.stop();
  } catch (err) {
    spinner.stop();
    return `Commit failed: ${(err as Error).message}`;
  }

  spinner = ora('Creating pull request…').start();
  let prUrl: string;
  try {
    prUrl = await createPR(
      config,
      issue.title,
      `Closes #${issueNumber}\n\n${issue.body ?? ''}`.trim(),
      branch,
      defaultBranch
    );
    spinner.stop();
  } catch (err) {
    spinner.stop();
    return `Committed but PR creation failed: ${(err as Error).message}`;
  }

  spinner = ora('Marking as in-review…').start();
  try {
    await markInReview(config, issueNumber);
    spinner.stop();
  } catch (err) {
    spinner.stop();
    return `PR created (${prUrl}) but failed to update label: ${(err as Error).message}`;
  }

  return `Task #${issueNumber} submitted.\nCommit: "${commitMessage.trim()}"\nPR: ${prUrl}\n\n${diff}`;
}

function buildClaudePrompt(issue: GitHubIssue, branch: string): string {
  const lines = [
    `You are working on task #${issue.number}: ${issue.title}`,
    `Branch: ${branch}`,
    '',
  ];
  if (issue.body) lines.push(issue.body.trim(), '');
  lines.push(
    'Implement the task. A detailed guide has been posted as a comment on the GitHub issue.',
    'When done, return to tch and run /submit to review and deliver.'
  );
  return lines.join('\n');
}

async function launchClaudeCode(issue: GitHubIssue, branch: string): Promise<void> {
  const prompt = buildClaudePrompt(issue, branch);
  console.log(chalk.dim('\n  Launching Claude Code…\n'));
  await new Promise<void>((resolve) => {
    const child = spawn('claude', [prompt], { stdio: 'inherit', shell: true });
    child.on('close', () => resolve());
    child.on('error', () => {
      console.log(
        chalk.yellow(
          '  Could not launch claude. Make sure Claude Code is installed:\n' +
            '  npm install -g @anthropic-ai/claude-code'
        )
      );
      resolve();
    });
  });
}

export async function runReject(
  config: TechunterConfig,
  opts: { issue_number: number; comment: string }
): Promise<string> {
  const { issue_number: issueNumber, comment } = opts;
  const divider = chalk.dim('─'.repeat(70));
  console.log('\n' + divider);
  console.log(chalk.bold(`  Rejection preview — issue #${issueNumber}`));
  console.log(divider);
  console.log(renderMarkdown(comment));
  console.log(divider + '\n');

  let decision: string;
  try {
    decision = await select({
      message: `Post rejection and mark #${issueNumber} as changes-needed?`,
      choices: [
        { name: 'Post & Reject', value: 'yes' },
        { name: 'Revise comment — describe what to change', value: 'revise' },
        { name: 'Cancel', value: 'cancel' },
      ],
    });
  } catch {
    return 'User cancelled rejection.';
  }

  if (decision === 'cancel') return 'User cancelled rejection.';

  if (decision === 'revise') {
    let feedback: string;
    try {
      feedback = await promptInput({ message: 'What should be changed in the rejection comment?' });
    } catch {
      return 'User cancelled.';
    }
    return `User requested revision. Feedback: "${feedback}". Revise and call reject again.`;
  }

  let spinner = ora(`Posting rejection comment on #${issueNumber}…`).start();
  try {
    await postComment(config, issueNumber, comment);
    spinner.stop();
  } catch (err) {
    spinner.stop();
    return `Error posting comment: ${(err as Error).message}`;
  }

  spinner = ora(`Marking #${issueNumber} as changes-needed…`).start();
  try {
    await rejectTask(config, issueNumber);
    spinner.stop();
  } catch (err) {
    spinner.stop();
    return `Comment posted but failed to update label: ${(err as Error).message}`;
  }

  return `Task #${issueNumber} rejected. Label changed to changes-needed.`;
}

export async function runCode(config: TechunterConfig): Promise<string> {
  let branch: string;
  try {
    branch = await getCurrentBranch();
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
  const match = branch.match(/^task-(\d+)-/);
  if (!match) return `Not on a task branch (current: ${branch}).`;
  const issueNum = parseInt(match[1], 10);
  let issue: GitHubIssue;
  try {
    issue = await getTask(config, issueNum);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
  await launchClaudeCode(issue, branch);
  return 'Claude Code session ended.';
}

export async function runPick(
  config: TechunterConfig,
  preselected?: number
): Promise<string> {
  let chosenNumber: number;

  if (preselected !== undefined) {
    chosenNumber = preselected;
  } else {
    let tasks: GitHubIssue[];
    try {
      tasks = await listTasks(config);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
    if (tasks.length === 0) return 'No tasks found.';
    try {
      chosenNumber = await select({
        message: 'Select a task:',
        choices: tasks.map((t) => ({
          name: `#${String(t.number).padEnd(4)} ${colorStatus(getStatus(t))} ${t.title}`,
          value: t.number,
        })),
      });
    } catch {
      return 'Cancelled.';
    }
  }

  let issue: GitHubIssue;
  try {
    issue = await getTask(config, chosenNumber);
  } catch (err) {
    return `Error loading task: ${(err as Error).message}`;
  }

  printTaskDetail(issue);

  const status = getStatus(issue);

  if (status === 'changes-needed') {
    try {
      const comments = await listComments(config, issue.number, 1);
      if (comments.length > 0) {
        const c = comments[0];
        const divider = chalk.dim('─'.repeat(70));
        console.log(
          chalk.red.bold('  Latest rejection feedback') +
            chalk.dim(` — @${c.author} · ${c.createdAt.slice(0, 10)}`)
        );
        console.log(divider);
        console.log(renderMarkdown(c.body));
        console.log(divider + '\n');
      }
    } catch {
      // silently skip
    }
  }

  const actions: { name: string; value: string }[] = [];
  if (status === 'available') {
    actions.push({ name: 'Claim this task', value: 'claim' });
  }
  if (status === 'claimed' || status === 'changes-needed') {
    actions.push({ name: 'Submit this task', value: 'submit' });
  }
  actions.push({ name: 'Close this task', value: 'close' });
  actions.push({ name: 'Nothing, just viewing', value: 'none' });

  let action: string;
  try {
    action = await select({ message: 'Action:', choices: actions });
  } catch {
    return 'Cancelled.';
  }

  if (action === 'none') return `Viewed task #${issue.number}.`;

  if (action === 'claim') {
    try {
      const me = await getAuthenticatedUser(config);
      let spinner = ora(`Claiming #${issue.number}…`).start();
      await claimTask(config, issue.number, me);
      spinner.stop();
      const branch = makeBranchName(issue.number, issue.title);
      spinner = ora(`Creating branch ${branch}…`).start();
      try {
        await createAndSwitchBranch(branch);
        spinner.stop();
      } catch {
        spinner.warn(`Could not create branch ${branch}`);
      }
      spinner = ora('Pushing branch…').start();
      try {
        await pushBranch(branch);
        spinner.stop();
      } catch {
        spinner.warn('Could not push branch');
      }
      console.log(chalk.green(`\n  Claimed! Branch: ${branch}\n`));
      let openClaude: boolean;
      try {
        openClaude = await select({
          message: 'Open Claude Code for this task?',
          choices: [
            { name: 'Yes, start coding now', value: true },
            { name: 'No, return to tch', value: false },
          ],
        });
      } catch {
        openClaude = false;
      }
      if (openClaude) await launchClaudeCode(issue, branch);
      return `Task #${issue.number} claimed. Branch: ${branch}`;
    } catch (err) {
      return `Error claiming task: ${(err as Error).message}`;
    }
  }

  if (action === 'submit') return runSubmit(config);
  if (action === 'close') return runClose(config, { issue_number: issue.number });

  return 'Cancelled.';
}
