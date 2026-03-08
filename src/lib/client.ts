import OpenAI from 'openai';
import type { TechunterConfig } from '../types.js';

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_MODEL = 'z-ai/glm-5';

export function createClient(config: TechunterConfig): OpenAI {
  return new OpenAI({
    baseURL: config.aiBaseUrl ?? DEFAULT_BASE_URL,
    apiKey: config.aiApiKey,
  });
}

export function getModel(config: TechunterConfig): string {
  return config.aiModel ?? DEFAULT_MODEL;
}
