import { readFile } from 'node:fs/promises';
import { renderMarkdown } from './markdown.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execAsync = promisify(exec);
import OpenAI from 'openai';
import ora from 'ora';
import chalk from 'chalk';
import { select, input as promptInput } from '@inquirer/prompts';
import type { TechunterConfig } from '../types.js';
import {
  listTasks,
  getTask,
  createTask,
  claimTask,
  closeTask,
  postComment,
  createPR,
  markInReview,
  rejectTask,
  listComments,
  getAuthenticatedUser,
  listMyTasks,
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
import { buildProjectContext } from './project.js';

function formatInput(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, v]) => {
      if (typeof v === 'number') return `${k}=${v}`;
      if (typeof v === 'string') {
        if (k === 'body' || v.length > 50) return `${k}=[${v.length} chars]`;
        return `${k}="${v}"`;
      }
      return `${k}=${JSON.stringify(v)}`;
    })
    .join('  ');
}

function summarize(result: string): string {
  const first = result.split('\n').find((l) => l.trim()) ?? result;
  return first.length > 100 ? first.slice(0, 97) + '...' : first;
}

const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'List all available and claimed tasks from GitHub Issues',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_task',
      description: 'Get full details of a specific GitHub issue: title, body, status, assignee.',
      parameters: {
        type: 'object',
        properties: {
          issue_number: { type: 'number', description: 'GitHub issue number' },
        },
        required: ['issue_number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a new task (GitHub Issue) marked as available',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title' },
          body: { type: 'string', description: 'Optional task description' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scan_project',
      description:
        'Scan the current project directory: returns the file tree and contents of the most relevant files. Call this before claiming a task so you have enough context to write a useful guide.',
      parameters: {
        type: 'object',
        properties: {
          focus: {
            type: 'string',
            description:
              'Keywords describing the task (e.g. issue title). Used to prioritise which files to read.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the full contents of a specific file in the project.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to the project root',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the project root directory. ' +
        'Use for building, testing, linting, git status checks, or any other project operations. ' +
        'stdout and stderr are both returned. Commands time out after 60 seconds.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to run (executed in the project root)',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'claim_task',
      description:
        'Assign a GitHub issue to yourself and create a local git branch. Call scan_project first, write a guide, post it with post_comment, then call this.',
      parameters: {
        type: 'object',
        properties: {
          issue_number: {
            type: 'number',
            description: 'The GitHub issue number to claim',
          },
        },
        required: ['issue_number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'post_comment',
      description: 'Post a markdown comment on a GitHub issue.',
      parameters: {
        type: 'object',
        properties: {
          issue_number: { type: 'number', description: 'GitHub issue number' },
          body: { type: 'string', description: 'Comment body (markdown)' },
        },
        required: ['issue_number', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_task',
      description: 'Close a GitHub issue and remove all techunter labels (equivalent to deleting a task).',
      parameters: {
        type: 'object',
        properties: {
          issue_number: { type: 'number', description: 'GitHub issue number to close' },
        },
        required: ['issue_number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Ask the user to clarify something that is ambiguous or missing in the task description — ' +
        'scope boundaries, expected behaviour, edge cases, or decisions that affect what needs to be built. ' +
        'Do NOT ask about technical implementation choices (those are your job). ' +
        'Use this at most 3 times per task. Do NOT use it for yes/no confirmation — ' +
        'post_comment handles confirmation automatically.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question to ask the user',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '2–4 concrete answer choices based on codebase context',
          },
        },
        required: ['question', 'options'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_diff',
      description:
        'Get the current git diff: changed files, diff vs HEAD, and any unpushed commits. ' +
        'Call this before reviewing or submitting changes.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stage_and_commit',
      description:
        'Stage all changes, commit with the given message, and push to origin. ' +
        'Only call this after reviewing the diff and confirming it meets the acceptance criteria.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Commit message summarising what was done',
          },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deliver_task',
      description:
        'Deliver the current task: push the branch, create a pull request, and mark the issue as in-review',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_status',
      description: 'Show tasks currently assigned to the authenticated GitHub user',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_comments',
      description: 'Get the latest comments on a GitHub issue. Useful for reading rejection feedback or discussion.',
      parameters: {
        type: 'object',
        properties: {
          issue_number: { type: 'number', description: 'GitHub issue number' },
          limit: { type: 'number', description: 'Max number of latest comments to return (default 5)' },
        },
        required: ['issue_number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reject_task',
      description:
        'Reject an in-review task: post a structured rejection comment on the issue, ' +
        'then change the label from in-review to changes-needed (assignee unchanged).',
      parameters: {
        type: 'object',
        properties: {
          issue_number: { type: 'number', description: 'GitHub issue number to reject' },
          comment: { type: 'string', description: 'Structured rejection comment (markdown)' },
        },
        required: ['issue_number', 'comment'],
      },
    },
  },
];

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  config: TechunterConfig
): Promise<string> {
  try {
    switch (name) {
      case 'list_tasks': {
        const spinner = ora('Loading tasks...').start();
        try {
          const tasks = await listTasks(config);
          spinner.stop();
          if (tasks.length === 0) return 'No tasks found.';
          const lines = tasks.map((t) => {
            const status =
              t.labels.find((l) => l.startsWith('techunter:'))?.replace('techunter:', '') ??
              'unknown';
            const assignee = t.assignee ? `@${t.assignee}` : '—';
            return `  #${t.number}  [${status}]  ${assignee}  ${t.title}`;
          });
          return `Tasks (${tasks.length}):\n${lines.join('\n')}`;
        } catch (err) {
          spinner.stop();
          throw err;
        }
      }

      case 'get_task': {
        const issueNumber = input['issue_number'] as number;
        const issue = await getTask(config, issueNumber);
        const status =
          issue.labels.find((l) => l.startsWith('techunter:'))?.replace('techunter:', '') ??
          'unknown';
        const assignee = issue.assignee ? `@${issue.assignee}` : '—';
        const lines = [
          `#${issue.number}  [${status}]  ${assignee}`,
          `Title: ${issue.title}`,
          `URL: ${issue.htmlUrl}`,
        ];
        if (issue.body) lines.push(`\n${issue.body}`);
        return lines.join('\n');
      }

      case 'create_task': {
        const title = input['title'] as string;
        const body = input['body'] as string | undefined;
        const spinner = ora(`Creating task "${title}"...`).start();
        try {
          const issue = await createTask(config, title, body);
          spinner.stop();
          return `Task created: #${issue.number} "${issue.title}" — ${issue.htmlUrl}`;
        } catch (err) {
          spinner.stop();
          throw err;
        }
      }

      case 'close_task': {
        const issueNumber = input['issue_number'] as number;
        const spinner = ora(`Closing task #${issueNumber}...`).start();
        try {
          await closeTask(config, issueNumber);
          spinner.stop();
          return `Task #${issueNumber} closed.`;
        } catch (err) {
          spinner.stop();
          throw err;
        }
      }

      case 'scan_project': {
        const focus = (input['focus'] as string | undefined) ?? '';
        const spinner = ora('Scanning project...').start();
        try {
          const cwd = process.cwd();
          const context = await buildProjectContext(cwd, focus, '');
          spinner.stop();

          const fileCount = context.fileTree.split('\n').filter(Boolean).length;
          const readCount = Object.keys(context.keyFiles).length;
          const totalBytes = Object.values(context.keyFiles).reduce((s, c) => s + c.length, 0);
          const summary = `Scanned ${fileCount} files · ${readCount} read · ${(totalBytes / 1024).toFixed(1)} KB`;

          const parts: string[] = [summary, `## File tree\n\`\`\`\n${context.fileTree}\n\`\`\``];
          for (const [filePath, content] of Object.entries(context.keyFiles)) {
            parts.push(`## ${filePath}\n\`\`\`\n${content}\n\`\`\``);
          }
          return parts.join('\n\n');
        } catch (err) {
          spinner.stop();
          throw err;
        }
      }

      case 'read_file': {
        const filePath = input['path'] as string;
        try {
          const cwd = process.cwd();
          const fullPath = path.join(cwd, filePath);
          const content = await readFile(fullPath, 'utf-8');
          return content.length > 15_000
            ? content.slice(0, 15_000) + `\n\n... (truncated)`
            : content;
        } catch (err) {
          return `Error reading file: ${(err as Error).message}`;
        }
      }

      case 'run_command': {
        const command = input['command'] as string;
        const cwd = process.cwd();
        const spinner = ora(`$ ${command}`).start();
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd,
            timeout: 60_000,
            maxBuffer: 1024 * 1024,
          });
          spinner.stop();
          const out = [stdout, stderr].filter(Boolean).join('\n').trim();
          const result = out.length > 5000 ? out.slice(0, 5000) + '\n... (truncated)' : out;
          return result || '(no output)';
        } catch (err) {
          spinner.stop();
          const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
          const out = [e.stdout, e.stderr].filter(Boolean).join('\n').trim();
          return `Exit ${e.code ?? 1}:\n${out || e.message}`;
        }
      }

      case 'claim_task': {
        const issueNumber = input['issue_number'] as number;

        let spinner = ora(`Fetching issue #${issueNumber}...`).start();
        const [issue, me] = await Promise.all([
          getTask(config, issueNumber),
          getAuthenticatedUser(config),
        ]);
        spinner.stop();

        if (issue.assignee && issue.assignee !== me) {
          return `Issue #${issueNumber} is already claimed by @${issue.assignee}.`;
        }

        // Ask user to confirm before assigning
        let confirmed: boolean;
        try {
          confirmed = await select({
            message: `Assign issue #${issueNumber} to @${me} and create branch?`,
            choices: [
              { name: 'Yes, assign it to me', value: true },
              { name: 'No, just keep the guide', value: false },
            ],
          });
        } catch {
          return 'User cancelled assignment.';
        }

        if (!confirmed) return 'Assignment cancelled. The guide has been posted.';

        spinner = ora('Claiming task...').start();
        await claimTask(config, issueNumber, me);
        spinner.stop();

        const branchName = makeBranchName(issueNumber, issue.title);
        spinner = ora(`Creating branch ${branchName}...`).start();
        try {
          await createAndSwitchBranch(branchName);
          spinner.stop();
        } catch {
          spinner.warn(`Could not create branch ${branchName}`);
        }

        spinner = ora(`Pushing branch ${branchName}...`).start();
        try {
          await pushBranch(branchName);
          spinner.stop();
        } catch {
          spinner.warn(`Could not push branch ${branchName}`);
        }

        return `Task #${issueNumber} claimed by @${me}. Branch: ${branchName}`;
      }

      case 'ask_user': {
        const question = input['question'] as string;
        const options = input['options'] as string[];
        const OTHER = '__other__';

        console.log('');
        console.log(chalk.dim('  ┌─ Agent question ' + '─'.repeat(51)));
        console.log(chalk.dim('  │'));
        for (const line of question.split('\n')) {
          console.log(chalk.dim('  │ ') + line);
        }
        console.log(chalk.dim('  └' + '─'.repeat(67)));

        let answer: string;
        try {
          const chosen = await select({
            message: ' ',
            choices: [
              ...options.map((o) => ({ name: o, value: o })),
              { name: chalk.dim('Other (describe below)'), value: OTHER },
            ],
          });
          if (chosen === OTHER) {
            answer = await promptInput({ message: 'Your answer:' });
          } else {
            answer = chosen;
          }
        } catch {
          answer = 'User skipped this question — use your best judgement.';
        }

        console.log('');
        return answer;
      }

      case 'post_comment': {
        const issueNumber = input['issue_number'] as number;
        const body = input['body'] as string;

        // Show full guide
        const divider = chalk.dim('─'.repeat(70));
        console.log('\n' + divider);
        console.log(chalk.bold(`  Guide preview — issue #${issueNumber}`));
        console.log(divider);
        console.log(renderMarkdown(body));
        console.log(divider + '\n');

        // Confirm before posting
        let decision: string;
        try {
          decision = await select({
            message: `Post this guide to issue #${issueNumber}?`,
            choices: [
              { name: 'Yes, post it', value: 'yes' },
              { name: 'No — describe what to change', value: 'revise' },
              { name: 'Cancel', value: 'cancel' },
            ],
          });
        } catch {
          return 'User cancelled posting.';
        }

        if (decision === 'cancel') return 'User cancelled posting.';

        if (decision === 'revise') {
          let feedback: string;
          try {
            feedback = await promptInput({ message: 'What should be changed?' });
          } catch {
            return 'User cancelled.';
          }
          return `User declined. Feedback: "${feedback}". Revise the guide and call post_comment again.`;
        }

        const spinner = ora(`Posting comment on #${issueNumber}...`).start();
        try {
          await postComment(config, issueNumber, body);
          spinner.stop();
          return `Comment posted on issue #${issueNumber}.`;
        } catch (err) {
          spinner.stop();
          throw err;
        }
      }

      case 'deliver_task': {
        const branch = await getCurrentBranch();
        const match = branch.match(/^task-(\d+)-/);
        if (!match) {
          return `Current branch "${branch}" doesn't look like a task branch (expected task-N-...).`;
        }
        const issueNumber = parseInt(match[1], 10);

        let spinner = ora('Fetching issue details...').start();
        const [issue, defaultBranch] = await Promise.all([
          getTask(config, issueNumber),
          getDefaultBranch(config),
        ]);
        spinner.stop();

        spinner = ora(`Pushing branch ${branch}...`).start();
        try {
          await pushBranch(branch);
          spinner.stop();
        } catch {
          spinner.warn('Push failed, continuing...');
        }

        spinner = ora('Creating pull request...').start();
        const prUrl = await createPR(
          config,
          issue.title,
          `Closes #${issueNumber}\n\n${issue.body ?? ''}`.trim(),
          branch,
          defaultBranch
        );
        spinner.stop();

        spinner = ora('Marking issue as in-review...').start();
        await markInReview(config, issueNumber);
        spinner.stop();

        return `PR created: ${prUrl}`;
      }

      case 'get_diff': {
        const spinner = ora('Reading git diff...').start();
        try {
          const diff = await getDiff();
          spinner.stop();
          return diff;
        } catch (err) {
          spinner.stop();
          throw err;
        }
      }

      case 'stage_and_commit': {
        const aiMessage = input['message'] as string;

        // Let user edit the commit message before confirming
        let commitMessage: string;
        try {
          commitMessage = await promptInput({
            message: 'Commit message:',
            default: aiMessage,
          });
        } catch {
          return 'User cancelled commit.';
        }

        if (!commitMessage.trim()) return 'User cancelled commit.';

        const spinner = ora('Staging, committing and pushing...').start();
        try {
          await stageAllAndCommit(commitMessage.trim());
          spinner.stop();
          return `Changes committed and pushed: "${commitMessage.trim()}"`;
        } catch (err) {
          spinner.stop();
          throw err;
        }
      }

      case 'get_my_status': {
        const spinner = ora('Fetching your tasks...').start();
        const me = await getAuthenticatedUser(config);
        const tasks = await listMyTasks(config, me);
        spinner.stop();

        if (tasks.length === 0) return `No tasks currently assigned to @${me}.`;
        const lines = tasks.map((t) => {
          const status =
            t.labels.find((l) => l.startsWith('techunter:'))?.replace('techunter:', '') ??
            'unknown';
          return `  #${t.number}  [${status}]  ${t.title}`;
        });
        return `Tasks assigned to @${me}:\n${lines.join('\n')}`;
      }

      case 'get_comments': {
        const issueNumber = input['issue_number'] as number;
        const limit = (input['limit'] as number | undefined) ?? 5;
        const spinner = ora(`Loading comments for #${issueNumber}...`).start();
        try {
          const comments = await listComments(config, issueNumber, limit);
          spinner.stop();
          if (comments.length === 0) return `No comments on issue #${issueNumber}.`;
          const lines = comments.map((c) =>
            `--- @${c.author} (${c.createdAt.slice(0, 10)}) ---\n${c.body}`
          );
          return `Latest ${comments.length} comment(s) on #${issueNumber}:\n\n${lines.join('\n\n')}`;
        } catch (err) {
          spinner.stop();
          throw err;
        }
      }

      case 'reject_task': {
        const issueNumber = input['issue_number'] as number;
        const comment = input['comment'] as string;

        // Show full rejection comment preview
        const divider = chalk.dim('─'.repeat(70));
        console.log('\n' + divider);
        console.log(chalk.bold(`  Rejection preview — issue #${issueNumber}`));
        console.log(divider);
        console.log(renderMarkdown(comment));
        console.log(divider + '\n');

        // Confirm before posting
        let decision: string;
        try {
          decision = await select({
            message: `Post rejection comment and mark #${issueNumber} as changes-needed?`,
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
          return `User requested revision. Feedback: "${feedback}". Revise the rejection comment and call reject_task again.`;
        }

        const spinner = ora(`Posting rejection comment on #${issueNumber}...`).start();
        try {
          await postComment(config, issueNumber, comment);
          spinner.stop();
        } catch (err) {
          spinner.stop();
          throw err;
        }

        const spinner2 = ora(`Marking #${issueNumber} as changes-needed...`).start();
        try {
          await rejectTask(config, issueNumber);
          spinner2.stop();
        } catch (err) {
          spinner2.stop();
          throw err;
        }

        return `Task #${issueNumber} rejected. Comment posted and label changed to changes-needed.`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

export async function runAgentLoop(
  config: TechunterConfig,
  messages: OpenAI.ChatCompletionMessageParam[]
): Promise<string> {
  const client = new OpenAI({
    baseURL: 'https://api.ppio.com/openai',
    apiKey: config.aiApiKey,
  });

  const { owner, repo } = config.github;

  const systemMessage: OpenAI.ChatCompletionSystemMessageParam = {
    role: 'system',
    content: [
      'You are Techunter, an AI assistant managing GitHub tasks for a development team.',
      `Repository: ${owner}/${repo}`,
      'Respond in the same language the user writes in (Chinese or English).',
      'For conversational replies be concise. For task guides be thorough and detailed.',
      'Always use tools when the user requests an action.',
      '',
      '## Claiming a task — required sequence',
      '1. Call scan_project with the issue title as focus.',
      '2. Call read_file on any files that need closer inspection.',
      '3. If the task description leaves requirements unclear, call ask_user (max 3 times).',
      '   Ask about: missing scope, ambiguous expected behaviour, edge cases, or business decisions.',
      '   Do NOT ask about technical choices (architecture, libraries, patterns) — decide those yourself.',
      '4. Write the task guide (see format below) and call post_comment to post it.',
      '   post_comment shows the user a full preview and asks for confirmation.',
      '   If the user requests changes, revise and call post_comment again.',
      '5. Call claim_task — it will ask the user to confirm assignment before proceeding.',
      '',
      '## Task guide format',
      'The guide is a complete technical document a developer can work from independently.',
      'Write it in the same language as the conversation. Use markdown. Include ALL sections:',
      '',
      '### 📋 任务概述 / Task Overview',
      'One paragraph explaining what this task is, why it matters, and what done looks like.',
      '',
      '### 🏗 架构背景 / Architecture Context',
      'Explain where this task fits in the codebase. Reference specific files and modules.',
      'Describe how the affected code is currently structured and what will change.',
      '',
      '### ⚙️ 技术要求 / Technical Requirements',
      'Bullet list of specific technical constraints, patterns to follow, APIs to use,',
      'coding conventions found in the codebase that must be respected.',
      '',
      '### 📁 涉及文件 / Files Involved',
      'Table or list: each file path, whether to CREATE/MODIFY/DELETE, and what change is needed.',
      '',
      '### 🪜 实现步骤 / Implementation Steps',
      'Numbered, ordered, concrete steps. Each step should reference specific functions,',
      'classes, or file locations. Include code snippets where helpful.',
      '',
      '### ✅ 验收标准 / Acceptance Criteria',
      'Checkbox list of testable conditions that must all be true before the task is done.',
      '',
      '### ⚠️ 注意事项 / Pitfalls & Considerations',
      'Known edge cases, potential breaking changes, performance concerns, or gotchas',
      'specific to this codebase.',
      '',
      '## Reviewing and rejecting a task',
      'When asked to reject a task:',
      '1. Call get_task to read full issue details.',
      '2. Write a structured rejection comment (markdown) in the conversation language:',
      '',
      '### ❌ 打回原因 / Rejection Reason',
      'One paragraph: what was reviewed and what the main problem is.',
      '',
      '### 🔧 需要修改的内容 / Required Changes',
      'Numbered, specific, actionable items. Reference file names,',
      'function names, or acceptance criteria that were not met.',
      '',
      '### ✅ 未通过的验收标准 / Failed Acceptance Criteria',
      'Re-list each criterion that was NOT met, prefixed with ❌.',
      '',
      '### 📋 下一步 / Next Steps',
      'Clear instruction on what to fix and how to re-submit (via /submit or deliver_task).',
      '',
      '3. Call reject_task with issue_number and the full rejection comment.',
      '',
      '## Submitting changes',
      'When the user asks to submit, sync, or commit changes:',
      '1. Call get_diff to read all local changes.',
      '2. Parse the issue number from the current branch name (task-N-...) and call get_task.',
      '3. Review: does the diff satisfy each acceptance criterion? List what is complete and what is missing.',
      '4. If all criteria are met: call stage_and_commit with a concise commit message.',
      '5. If criteria are not met: clearly list the gaps. Do NOT call stage_and_commit.',
    ].join('\n'),
  };

  for (;;) {
    const isWindows = process.platform === 'win32';
    const spinner = isWindows ? null : ora({ text: chalk.dim('Thinking…'), color: 'cyan' }).start();
    if (isWindows) process.stdout.write(chalk.dim('  Thinking…'));

    let response: Awaited<ReturnType<typeof client.chat.completions.create>>;
    try {
      response = await client.chat.completions.create({
        model: 'zai-org/glm-5',
        tools,
        messages: [systemMessage, ...messages],
      });
    } catch (err) {
      if (spinner) spinner.stop(); else process.stdout.write('\r' + ' '.repeat(14) + '\r');
      throw err;
    }
    if (spinner) spinner.stop(); else process.stdout.write('\r' + ' '.repeat(14) + '\r');

    const choice = response.choices[0];
    const assistantMessage: OpenAI.ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      content: choice.message.content ?? null,
      ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
    };
    messages.push(assistantMessage);

    if (choice.finish_reason === 'stop') {
      return choice.message.content ?? '';
    }

    if (choice.finish_reason === 'tool_calls') {
      const toolCalls = choice.message.tool_calls ?? [];

      // Print what the agent is about to call
      for (const tc of toolCalls) {
        const params = formatInput(JSON.parse(tc.function.arguments) as Record<string, unknown>);
        console.log(`  ${chalk.cyan('→')} ${chalk.bold(tc.function.name)}${params ? '  ' + chalk.dim(params) : ''}`);
      }

      const results = await Promise.all(
        toolCalls.map((tc) =>
          executeTool(
            tc.function.name,
            JSON.parse(tc.function.arguments) as Record<string, unknown>,
            config
          )
        )
      );

      // Print result summaries
      for (let i = 0; i < toolCalls.length; i++) {
        const ok = !results[i].startsWith('Error:');
        const icon = ok ? chalk.green('✓') : chalk.red('✗');
        console.log(`  ${icon} ${chalk.dim(summarize(results[i]))}`);

        const toolMessage: OpenAI.ChatCompletionToolMessageParam = {
          role: 'tool',
          tool_call_id: toolCalls[i].id,
          content: results[i],
        };
        messages.push(toolMessage);
      }
    } else {
      return choice.message.content ?? '';
    }
  }
}
