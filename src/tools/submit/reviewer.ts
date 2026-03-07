import { readFile } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type OpenAI from 'openai';
import type { TechunterConfig, GitHubIssue } from '../../types.js';
import { createClient, MODEL } from '../../lib/client.js';
import { getDiff } from '../../lib/git.js';
import { REVIEWER_SYSTEM_PROMPT } from './prompts.js';

const execAsync = promisify(exec);

const REVIEW_TOOLS: OpenAI.ChatCompletionTool[] = [
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

async function runTool(name: string, args: Record<string, string>): Promise<string> {
  const cwd = process.cwd();
  if (name === 'run_command') {
    try {
      const { stdout, stderr } = await execAsync(args['command']!, { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 });
      const out = [stdout, stderr].filter(Boolean).join('\n').trim();
      return out.length > 5000 ? out.slice(0, 5000) + '\n... (truncated)' : out || '(no output)';
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
      return `Exit ${err.code ?? 1}:\n${[err.stdout, err.stderr].filter(Boolean).join('\n') || err.message}`;
    }
  }
  if (name === 'read_file') {
    try {
      const content = await readFile(path.join(cwd, args['path']!), 'utf-8');
      return content.length > 10_000 ? content.slice(0, 10_000) + '\n... (truncated)' : content;
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  }
  if (name === 'get_diff') {
    try {
      return await getDiff();
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  }
  return `Unknown tool: ${name}`;
}

export async function reviewChanges(
  config: TechunterConfig,
  issueNumber: number,
  issue: GitHubIssue,
  diff: string
): Promise<string> {
  const client = createClient(config);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: REVIEWER_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Task #${issueNumber}: ${issue.title}\n\nAcceptance Criteria:\n${issue.body ?? '(none)'}\n\nDiff:\n${diff || '(no changes)'}`,
    },
  ];

  for (;;) {
    const res = await client.chat.completions.create({
      model: MODEL,
      tools: REVIEW_TOOLS,
      messages,
    });
    const choice = res.choices[0];
    messages.push({
      role: 'assistant',
      content: choice.message.content ?? null,
      ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
    });

    if (choice.finish_reason === 'stop') {
      return choice.message.content ?? '';
    }

    if (choice.finish_reason === 'tool_calls') {
      for (const tc of choice.message.tool_calls ?? []) {
        const args = JSON.parse(tc.function.arguments) as Record<string, string>;
        const result = await runTool(tc.function.name, args);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }
  }
}
