import type { TechunterConfig } from '../../types.js';
import { runSubAgentLoop } from '../../lib/sub-agent.js';
import { WIKI_FORMAT } from './prompts.js';

export async function generateWiki(config: TechunterConfig): Promise<string> {
  return runSubAgentLoop(
    config,
    'You are a senior engineer writing a project overview document for new team members. ' +
      'Use list_files to understand the project structure, then grep_code and run_command to read key files ' +
      '(e.g. package.json, README, entry points, config files). ' +
      'Be concrete and specific — reference real file names, commands, and concepts from this codebase. ' +
      'Avoid vague filler. When you have enough context, write the document.\n\n' + WIKI_FORMAT,
    'Analyze this project thoroughly and produce a comprehensive TECHUNTER.md overview document for new team members.',
    ['list_files', 'grep_code', 'run_command'],
  );
}
