import type OpenAI from 'openai';
import ora from 'ora';
import chalk from 'chalk';
import type { TechunterConfig } from '../types.js';
import { toolModules } from '../tools/registry.js';
import { createClient, getModel } from './client.js';
import { printToolCall, printToolResult } from './agent-ui.js';

const tools = toolModules.map((m) => m.definition as OpenAI.ChatCompletionTool);

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  config: TechunterConfig
): Promise<string> {
  const mod = toolModules.find((m) => m.definition.function.name === name);
  if (!mod) return `Unknown tool: ${name}`;
  try {
    const fn = mod.run ?? mod.execute;
    return await fn(input, config);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

export async function runAgentLoop(
  config: TechunterConfig,
  messages: OpenAI.ChatCompletionMessageParam[]
): Promise<string> {
  const client = createClient(config);

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
      '## Creating a task',
      'If the task description is vague, call ask_user to clarify (max 3 times).',
      'Then call new_task with the title — the tool scans the project and generates the guide automatically.',
      '',
      '## Claiming a task',
      'Call pick with the issue_number — the tool handles everything.',
      'Do NOT scan or generate anything for claiming.',
      '',
      '## Rejecting a task',
      'Call reject with the issue_number — the tool collects feedback and generates the comment.',
      '',
      '## Submitting changes',
      'When the user asks to submit, deliver, push, or finish their work:',
      'Call submit directly — it handles AI review, confirmation, commit, and PR creation.',
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

  const MAX_ITERATIONS = 30;
  let iterations = 0;

  for (;;) {
    if (++iterations > MAX_ITERATIONS) {
      throw new Error(`Agent exceeded ${MAX_ITERATIONS} iterations without finishing.`);
    }
    const spinner = ora({ text: chalk.dim('Thinking…'), color: 'cyan' }).start();

    let response: Awaited<ReturnType<typeof client.chat.completions.create>>;
    try {
      response = await client.chat.completions.create({
        model: getModel(config),
        tools,
        messages: [systemMessage, ...messages],
      });
    } catch (err) {
      spinner.stop();
      throw err;
    }
    spinner.stop();

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

      for (const tc of toolCalls) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        printToolCall(tc.function.name, parsed);
      }

      const results = await Promise.all(
        toolCalls.map((tc) => {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            parsed = {};
          }
          return executeTool(tc.function.name, parsed, config);
        })
      );

      let terminal = false;
      for (let i = 0; i < toolCalls.length; i++) {
        printToolResult(results[i]);
        messages.push({
          role: 'tool',
          tool_call_id: toolCalls[i].id,
          content: results[i],
        });
        if (toolModules.find((m) => m.definition.function.name === toolCalls[i].function.name)?.terminal) {
          terminal = true;
        }
      }
      if (terminal) return results[results.length - 1];
    } else {
      return choice.message.content ?? '';
    }
  }
}
