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
}): Promise<string> {
  const client = createAiClient(input.config);
  const tools = input.tools ?? [];
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'system', content: input.systemPrompt }];
  for (const message of (input.history ?? []).slice(-16)) {
    messages.push({ role: message.role, content: message.content });
  }
  messages.push({ role: 'user', content: input.userMessage });
  const definitions = tools.map((tool) => tool.definition as OpenAI.ChatCompletionTool);
  const maxIterations = input.maxIterations ?? 30;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const response = await client.chat.completions.create({
      model: getAiModel(input.config),
      messages,
      ...(definitions.length ? { tools: definitions } : {}),
    });
    const choice = response.choices[0];
    if (!choice) throw new Error('Agent 没有返回任何结果。');
    messages.push({
      role: 'assistant',
      content: choice.message.content ?? null,
      ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
    });

    if (choice.finish_reason === 'tool_calls') {
      for (const call of choice.message.tool_calls ?? []) {
        let toolInput: Record<string, unknown> = {};
        try { toolInput = JSON.parse(call.function.arguments) as Record<string, unknown>; } catch { /* empty input */ }
        const tool = tools.find((candidate) => candidate.definition.function.name === call.function.name);
        input.hooks?.onToolCall?.(call.function.name, toolInput);
        let result: string;
        try {
          result = tool
            ? await tool.execute(toolInput)
            : `Unknown tool: ${call.function.name}`;
        } catch (error) {
          result = `Tool error: ${(error as Error).message}`;
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
