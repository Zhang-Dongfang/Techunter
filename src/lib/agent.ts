import { readFile } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { renderMarkdown } from './markdown.js';

const execAsync = promisify(exec);
import OpenAI from 'openai';
import ora from 'ora';
import chalk from 'chalk';
import { select, input as promptInput } from '@inquirer/prompts';
import type { TechunterConfig } from '../types.js';
import {
  getTask,
  listComments,
} from './github.js';
import { getDiff } from './git.js';
import { buildProjectContext } from './project.js';
import {
  runRefresh,
  runNew,
  runClose,
  runStatus,
  runReview,
  runSubmit,
  runCode,
  runPick,
  runReject,
} from './commands.js';

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
  // ─── Command tools (hardcoded flows, same as /commands) ───────────────────
  {
    type: 'function',
    function: {
      name: 'pick',
      description:
        'Browse the task list and act on a specific task (claim, submit, close, or view). ' +
        'Equivalent to /pick. Use when the user wants to explore or take action on a task.',
      parameters: {
        type: 'object',
        properties: {
          issue_number: {
            type: 'number',
            description: 'Pre-select a specific issue to jump directly to it (optional).',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'new_task',
      description:
        'Create a new task (GitHub Issue) interactively. ' +
        'Equivalent to /new. Prompts the user for a title if not provided.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title (optional — user will be prompted if omitted)' },
          body: { type: 'string', description: 'Task description (optional)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close',
      description:
        'Close a task (GitHub Issue). ' +
        'Equivalent to /close. Shows a task picker if issue_number is not provided.',
      parameters: {
        type: 'object',
        properties: {
          issue_number: {
            type: 'number',
            description: 'Issue number to close (optional — user will be prompted if omitted)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit',
      description:
        'Submit the current task: commit all changes, create a pull request, and mark the issue as in-review. ' +
        'Equivalent to /submit. Must be on a task branch (task-N-title).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'my_status',
      description: 'Show all tasks currently assigned to the authenticated GitHub user. Equivalent to /status.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'review',
      description:
        'List tasks waiting for your review (submitted by others, created by you). Equivalent to /review.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'refresh',
      description: 'Reload and display the full task list. Equivalent to /refresh.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_code',
      description: 'Launch Claude Code for the current task branch. Equivalent to /code.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reject',
      description:
        'Reject an in-review task: shows a preview of the rejection comment, asks user to confirm, ' +
        'then posts the comment and changes the label to changes-needed.',
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

  // ─── Low-level tools ─────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'scan_project',
      description:
        'Scan the current project directory: returns the file tree and contents of the most relevant files. ' +
        'Call this when creating a new task to understand the codebase before writing the task body and guide.',
      parameters: {
        type: 'object',
        properties: {
          focus: {
            type: 'string',
            description: 'Keywords describing the task. Used to prioritise which files to read.',
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
          path: { type: 'string', description: 'File path relative to the project root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Ask the user to clarify something ambiguous — scope, expected behaviour, edge cases, or business decisions. ' +
        'Do NOT ask about technical implementation choices. Use at most 3 times per task.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask the user' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '2–4 concrete answer choices',
          },
        },
        required: ['question', 'options'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the project root directory. ' +
        'Use for building, testing, linting, or git status checks. ' +
        'stdout and stderr are both returned. Commands time out after 60 seconds.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run' },
        },
        required: ['command'],
      },
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
      name: 'get_comments',
      description: 'Get the latest comments on a GitHub issue. Useful for reading rejection feedback.',
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
      name: 'get_diff',
      description: 'Get the current git diff: changed files, diff vs HEAD, and any unpushed commits.',
      parameters: { type: 'object', properties: {}, required: [] },
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
      // ─── Command tools ───────────────────────────────────────────────────────
      case 'pick':
        return await runPick(config, input['issue_number'] as number | undefined);
      case 'new_task':
        return await runNew(config, {
          title: input['title'] as string | undefined,
          body: input['body'] as string | undefined,
        });
      case 'close':
        return await runClose(config, { issue_number: input['issue_number'] as number | undefined });
      case 'submit':
        return await runSubmit(config);
      case 'my_status':
        return await runStatus(config);
      case 'review':
        return await runReview(config);
      case 'refresh':
        return await runRefresh(config);
      case 'open_code':
        return await runCode(config);
      case 'reject':
        return await runReject(config, {
          issue_number: input['issue_number'] as number,
          comment: input['comment'] as string,
        });

      // ─── Low-level tools ─────────────────────────────────────────────────────
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
          return content.length > 15_000 ? content.slice(0, 15_000) + '\n\n... (truncated)' : content;
        } catch (err) {
          return `Error reading file: ${(err as Error).message}`;
        }
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
          answer = chosen === OTHER ? await promptInput({ message: 'Your answer:' }) : chosen;
        } catch {
          answer = 'User skipped this question — use your best judgement.';
        }
        console.log('');
        return answer;
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
      '## Tool philosophy',
      'Command tools (pick, new_task, close, submit, my_status, review, refresh, open_code) run',
      'hardcoded interactive flows — always use these for user-facing actions.',
      'Low-level tools are for reasoning: run_command, scan_project, read_file, ask_user,',
      'get_task, get_comments, get_diff.',
      '',
      '## Creating a task — required sequence',
      '1. If the task description is vague, call ask_user to clarify scope (max 3 times).',
      '2. Call scan_project with the task title as focus.',
      '3. Call read_file on any files that need closer inspection.',
      '4. Call new_task with a well-written title AND a full implementation guide as the body.',
      '   The body IS the guide — write it directly, do not call any comment tool after.',
      '',
      '## Claiming a task',
      'When the user wants to claim an existing task, call pick with the issue_number.',
      'The pick flow handles everything: shows details, confirms, creates branch, pushes.',
      'Do NOT scan or generate a guide for claiming — the guide was written at creation time.',
      '',
      '## Guide format',
      'Write the guide in the same language as the conversation. Use markdown. Include ALL sections:',
      '',
      '### 📋 任务概述 / Task Overview',
      'One paragraph: what this task is, why it matters, what done looks like.',
      '',
      '### 🏗 架构背景 / Architecture Context',
      'Where this task fits in the codebase. Reference specific files and modules.',
      '',
      '### ⚙️ 技术要求 / Technical Requirements',
      'Bullet list of constraints, patterns, APIs, and coding conventions to follow.',
      '',
      '### 📁 涉及文件 / Files Involved',
      'Each file path, whether to CREATE/MODIFY/DELETE, and what change is needed.',
      '',
      '### 🪜 实现步骤 / Implementation Steps',
      'Numbered, concrete steps referencing specific functions and file locations.',
      '',
      '### ✅ 验收标准 / Acceptance Criteria',
      'Checkbox list of testable conditions that must all be true before the task is done.',
      '',
      '### ⚠️ 注意事项 / Pitfalls & Considerations',
      'Edge cases, breaking changes, performance concerns specific to this codebase.',
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
      '3. Call reject with issue_number and the full rejection comment.',
      '',
      '## Submitting changes',
      'When the user asks to submit, deliver, push, or finish their work:',
      'Call submit directly — it shows the task details and diff to the user and handles confirmation.',
      '',
      '## Reviewing submitted tasks',
      'When the user asks to review tasks or check what needs approval:',
      '1. Call review to list tasks pending your approval.',
      '2. Call get_task to read full details of the task to review.',
      '3. Call get_comments to read the implementation guide and any discussion.',
      '4. To approve: call close with the issue_number.',
      '5. To reject: write a structured rejection comment and call reject.',
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
