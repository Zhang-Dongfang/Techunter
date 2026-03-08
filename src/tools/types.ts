import type OpenAI from 'openai';
import type { TechunterConfig } from '../types.js';

export interface ToolModule {
  definition: OpenAI.ChatCompletionTool;
  execute(input: Record<string, unknown>, config: TechunterConfig): Promise<string>;
  /** Interactive version called by the in-app agent — delegates to execute() if absent. Only terminal tools define this. */
  run?(input: Record<string, unknown>, config: TechunterConfig): Promise<string>;
  /** If true, the agent loop exits immediately after this tool completes. */
  terminal?: boolean;
}
