import { spawn } from 'node:child_process';
import chalk from 'chalk';
import type { GitHubIssue } from '../types.js';

export function buildClaudePrompt(issue: GitHubIssue, branch: string): string {
  const lines = [
    `You are working on task #${issue.number}: ${issue.title}`,
    `Branch: ${branch}`,
    '',
  ];
  if (issue.body) lines.push(issue.body.trim(), '');
  lines.push(
    'Implement the task. A detailed guide has been posted as a comment on the GitHub issue.',
    'When done, return to tch and run /submit to review and deliver.'
  );
  return lines.join('\n');
}

export async function launchClaudeCode(issue: GitHubIssue, branch: string): Promise<void> {
  const prompt = buildClaudePrompt(issue, branch);
  console.log(chalk.dim('\n  Launching Claude Code…\n'));
  await new Promise<void>((resolve) => {
    // Flatten newlines and quote the prompt so the shell passes it as a single argument
    const safePrompt = prompt.replace(/\r?\n/g, ' ').replace(/"/g, "'");
    const child = spawn(`claude "${safePrompt}"`, [], { stdio: 'inherit', shell: true });
    child.on('close', () => resolve());
    child.on('error', () => {
      console.log(
        chalk.yellow(
          '  Could not launch claude. Make sure Claude Code is installed:\n' +
          '  npm install -g @anthropic-ai/claude-code'
        )
      );
      resolve();
    });
  });
}
