import ora from 'ora';
import type { TechunterConfig } from '../../types.js';
import { buildProjectContext } from '../../lib/project.js';

export const definition = {
  type: 'function',
  function: {
    name: 'scan_project',
    description:
      'Scan the current project directory: returns the file tree and contents of the most relevant files. ' +
      'Call this when creating a new task to understand the codebase before writing the task body and guide.',
    parameters: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          description: 'Keywords describing the task. Used to prioritise which files to read.',
        },
      },
      required: [],
    },
  },
} as const;

export async function execute(input: Record<string, unknown>, _config: TechunterConfig): Promise<string> {
  const focus = (input['focus'] as string | undefined) ?? '';
  const spinner = ora('Scanning project...').start();
  try {
    const cwd = process.cwd();
    const context = await buildProjectContext(cwd, focus, '');
    spinner.stop();
    const fileCount = context.fileTree.split('\n').filter(Boolean).length;
    const readCount = Object.keys(context.keyFiles).length;
    const totalBytes = Object.values(context.keyFiles).reduce((s, c) => s + c.length, 0);
    const summary = `Scanned ${fileCount} files · ${readCount} read · ${(totalBytes / 1024).toFixed(1)} KB`;
    const parts: string[] = [summary, `## File tree\n\`\`\`\n${context.fileTree}\n\`\`\``];
    for (const [filePath, content] of Object.entries(context.keyFiles)) {
      parts.push(`## ${filePath}\n\`\`\`\n${content}\n\`\`\``);
    }
    return parts.join('\n\n');
  } catch (err) {
    spinner.stop();
    throw err;
  }
}
