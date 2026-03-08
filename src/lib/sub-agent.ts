import type OpenAI from 'openai';
import type { TechunterConfig } from '../types.js';
import { toolModules } from '../tools/registry.js';
import { createClient, getModel } from './client.js';
import { printToolCall, printToolResult } from './agent-ui.js';

export async function runSubAgentLoop(
  config: TechunterConfig,
  systemPrompt: string,
  userMessage: string,
  toolNames: string[]
): Promise<string> {
  const client = createClient(config);
  const selected = toolModules.filter((m) => toolNames.includes(m.definition.function.name));
  const tools = selected.map((m) => m.definition as OpenAI.ChatCompletionTool);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  const MAX_ITERATIONS = 20;
  let iterations = 0;

  for (;;) {
    if (++iterations > MAX_ITERATIONS) {
      throw new Error(`Sub-agent exceeded ${MAX_ITERATIONS} iterations without finishing.`);
    }
    const res = await client.chat.completions.create({ model: getModel(config), tools, messages });
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
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          input = {};
        }
        printToolCall(tc.function.name, input);
        const mod = selected.find((m) => m.definition.function.name === tc.function.name);
        const result = mod
          ? await mod.execute(input, config)
          : `Unknown tool: ${tc.function.name}`;
        printToolResult(result);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }
  }
}
