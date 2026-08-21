import type { TechunterConfig } from '../types.js';
import { toolModules } from '../tools/registry.js';
import { runAgentLoop, type AgentTool } from '@techunter/core';
import { printToolCall, printToolResult } from './agent-ui.js';

export async function runSubAgentLoop(
  config: TechunterConfig,
  systemPrompt: string,
  userMessage: string,
  toolNames: string[]
): Promise<string> {
  const selected = toolModules.filter((m) => toolNames.includes(m.definition.function.name));
  const tools: AgentTool[] = selected.map((tool) => ({
    definition: tool.definition as AgentTool['definition'],
    execute: (input) => tool.execute(input, config),
  }));
  return runAgentLoop({
    config,
    systemPrompt,
    userMessage,
    tools,
    maxIterations: 100,
    hooks: {
      onToolCall: (name, input) => printToolCall(name, input),
      onToolResult: (_name, result) => printToolResult(result),
    },
  });
}
