import type { TechunterConfig } from '../../types.js';
import { runSubAgentLoop } from '../../lib/sub-agent.js';
import { GUIDE_FORMAT } from './prompts.js';

export async function generateGuide(
  config: TechunterConfig,
  title: string,
  revise?: { feedback: string; previousGuide: string }
): Promise<string> {
  const userMessage = revise
    ? `Revise the following implementation guide for task: "${title}"\n\n` +
      `User feedback: ${revise.feedback}\n\n` +
      `Previous guide:\n${revise.previousGuide}`
    : `Write an implementation guide for this task: "${title}"`;

  return runSubAgentLoop(
    config,
    'You are a senior engineer writing a brief task guide for a developer. ' +
      'Use list_files then grep_code to identify which files are relevant. ' +
      'Do NOT include code snippets or implementation details. ' +
      'When you have enough context, write the guide.\n\n' + GUIDE_FORMAT,
    userMessage,
    ['list_files', 'grep_code', 'run_command', 'ask_user']
  );
}
