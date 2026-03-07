import type OpenAI from 'openai';
import type { TechunterConfig } from '../types.js';

export interface ToolModule {
  definition: OpenAI.ChatCompletionTool;
  execute(input: Record<string, unknown>, config: TechunterConfig): Promise<string>;
}
