import type { TechunterConfig } from '../../types.js';
import { runSubAgentLoop } from '../../lib/sub-agent.js';
import { GUIDE_FORMAT } from './prompts.js';

export async function generateGuide(config: TechunterConfig, title: string): Promise<string> {
  return runSubAgentLoop(
    config,
    'You are a senior engineer writing a task implementation guide. ' +
      'Use scan_project to understand the codebase, read_file to inspect specific files, ' +
      'run_command to check scripts or dependencies, and ask_user to clarify requirements if needed. ' +
      'When you have enough context, write the complete guide.\n\n' + GUIDE_FORMAT,
    `Write an implementation guide for this task: "${title}"`,
    ['scan_project', 'read_file', 'run_command', 'ask_user']
  );
}
