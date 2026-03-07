import type OpenAI from 'openai';
import type { TechunterConfig } from '../types.js';

export interface ToolModule {
  definition: OpenAI.ChatCompletionTool;
  execute(input: Record<string, unknown>, config: TechunterConfig): Promise<string>;
  /** If true, the agent loop exits immediately after this tool completes. */
  terminal?: boolean;
}
