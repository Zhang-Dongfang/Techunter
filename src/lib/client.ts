import OpenAI from 'openai';
import type { TechunterConfig } from '../types.js';

export function createClient(config: TechunterConfig): OpenAI {
  return new OpenAI({
    baseURL: 'https://api.ppio.com/openai',
    apiKey: config.aiApiKey,
  });
}

export const MODEL = 'zai-org/glm-5';
