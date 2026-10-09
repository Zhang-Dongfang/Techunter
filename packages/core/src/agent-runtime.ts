import type OpenAI from 'openai';

import { createAiClient, getAiModel } from './client.js';
import type { AgentChatMessage, AgentHooks, AgentTool, AiConfig } from './types.js';

export async function runAgentLoop(input: {
  config: AiConfig;
  systemPrompt: string;
  userMessage: string;
  history?: AgentChatMessage[];
  tools?: AgentTool[];
  hooks?: AgentHooks;
  maxIterations?: number;
  signal?: AbortSignal;
  maxRuntimeMs?: number;
  maxContextChars?: number;
  maxTotalTokens?: number;
  maxOutputTokens?: number;
  maxToolResultChars?: number;
  client?: Pick<OpenAI, 'chat'>;
}): Promise<string> {
  const client = input.client ?? createAiClient(input.config);
  const positive = (value: number, label: string) => {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} 必须是正整数。`);
    return value;
  };
  const startedAt = Date.now();
  const maxRuntimeMs = positive(input.maxRuntimeMs ?? 180_000, 'maxRuntimeMs');
  const deadline = AbortSignal.timeout(maxRuntimeMs);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const maxContextChars = positive(input.maxContextChars ?? 250_000, 'maxContextChars');
  const maxTotalTokens = positive(input.maxTotalTokens ?? 120_000, 'maxTotalTokens');
  const maxOutputTokens = positive(input.maxOutputTokens ?? 4_096, 'maxOutputTokens');
  const maxToolResultChars = positive(input.maxToolResultChars ?? 16_000, 'maxToolResultChars');
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  const tools = input.tools ?? [];
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'system', content: input.systemPrompt }];
  for (const message of (input.history ?? []).slice(-16)) {
    messages.push({ role: message.role, content: message.content });
  }
  messages.push({ role: 'user', content: input.userMessage });
  const definitions = tools.map((tool) => tool.definition as OpenAI.ChatCompletionTool);
  const maxIterations = positive(input.maxIterations ?? 30, 'maxIterations');

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    signal.throwIfAborted();
    if (JSON.stringify({ messages, tools: definitions }).length > maxContextChars) {
      throw new Error('Agent 上下文超过预算，请缩小任务或减少交付证据。');
    }
    if (totalTokens >= maxTotalTokens) throw new Error('Agent 已达到 token 预算。');
    const response = await client.chat.completions.create({
      model: getAiModel(input.config),
      messages,
      ...(definitions.length ? { tools: definitions } : {}),
      max_tokens: Math.min(maxOutputTokens, maxTotalTokens - totalTokens),
    }, { signal, timeout: Math.max(1, maxRuntimeMs - (Date.now() - startedAt)), maxRetries: 0 });
    signal.throwIfAborted();
    promptTokens += response.usage?.prompt_tokens ?? 0;
    completionTokens += response.usage?.completion_tokens ?? 0;
    totalTokens += response.usage?.total_tokens ?? 0;
    input.hooks?.onUsage?.({ iteration, promptTokens, completionTokens, totalTokens, elapsedMs: Date.now() - startedAt });
    if (totalTokens > maxTotalTokens) throw new Error('Agent 已超过 token 预算。');
    const choice = response.choices[0];
    if (!choice) throw new Error('Agent 没有返回任何结果。');
    if (choice.finish_reason === 'length') throw new Error('Agent 输出被截断，请缩小任务或提高输出预算。');
    messages.push({
      role: 'assistant',
      content: choice.message.content ?? null,
      ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
    });

    if (choice.finish_reason === 'tool_calls') {
      for (const call of choice.message.tool_calls ?? []) {
        signal.throwIfAborted();
        let toolInput: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(call.function.arguments);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Tool arguments must be an object.');
          toolInput = parsed as Record<string, unknown>;
        } catch {
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'Tool error: invalid JSON object arguments; correct the arguments before retrying.' });
          continue;
        }
        const tool = tools.find((candidate) => candidate.definition.function.name === call.function.name);
        input.hooks?.onToolCall?.(call.function.name, toolInput);
        let result: string;
        try {
          result = tool
            ? await tool.execute(toolInput, { signal })
            : `Unknown tool: ${call.function.name}`;
        } catch (error) {
          signal.throwIfAborted();
          result = `Tool error: ${(error as Error).message}`;
        }
        signal.throwIfAborted();
        if (result.length > maxToolResultChars) {
          result = `${result.slice(0, maxToolResultChars)}\n[Tool output truncated; narrow the search or read a specific range.]`;
        }
        input.hooks?.onToolResult?.(call.function.name, result);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      continue;
    }

    if (choice.message.content) return choice.message.content;
    throw new Error(`Agent 在 ${choice.finish_reason ?? 'unknown'} 状态下没有返回内容。`);
  }

  throw new Error(`Agent 超过 ${maxIterations} 轮仍未完成。`);
}
