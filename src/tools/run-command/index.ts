import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import ora from 'ora';
import type { TechunterConfig } from '../../types.js';

const execAsync = promisify(exec);

export const definition = {
  type: 'function',
  function: {
    name: 'run_command',
    description:
      'Run a shell command in the project root directory. ' +
      'Use for building, testing, linting, or git status checks. ' +
      'stdout and stderr are both returned. Commands time out after 60 seconds.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run' },
      },
      required: ['command'],
    },
  },
} as const;

export async function execute(input: Record<string, unknown>, _config: TechunterConfig): Promise<string> {
  const command = input['command'] as string;
  const cwd = process.cwd();
  const spinner = ora(`$ ${command}`).start();
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 });
    spinner.stop();
    const out = [stdout, stderr].filter(Boolean).join('\n').trim();
    const result = out.length > 5000 ? out.slice(0, 5000) + '\n... (truncated)' : out;
    return result || '(no output)';
  } catch (err) {
    spinner.stop();
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    const out = [e.stdout, e.stderr].filter(Boolean).join('\n').trim();
    return `Exit ${e.code ?? 1}:\n${out || e.message}`;
  }
}
