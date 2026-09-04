import type { TechunterConfig } from '../../types.js';
import { analyzeTaskWithAgent, renderTaskGuide } from '@techunter/core';
import { printToolCall, printToolResult } from '../../lib/agent-ui.js';

export async function generateGuide(
  config: TechunterConfig,
  title: string,
  revise?: { feedback: string; previousGuide: string }
): Promise<string> {
  const spec = await analyzeTaskWithAgent({
    config,
    title,
    description: title,
    repository: { root: process.cwd(), allowCommands: true },
    feedback: revise?.feedback,
    previousGuide: revise?.previousGuide,
    hooks: {
      onToolCall: (name, input) => printToolCall(name, input),
      onToolResult: (_name, result) => printToolResult(result),
    },
  });
  return renderTaskGuide(spec);
}
