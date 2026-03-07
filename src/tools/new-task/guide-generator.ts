import type { TechunterConfig } from '../../types.js';
import { buildProjectContext } from '../../lib/project.js';
import { createClient, MODEL } from '../../lib/client.js';
import { GUIDE_FORMAT } from './prompts.js';

export async function generateGuide(config: TechunterConfig, title: string): Promise<string> {
  const client = createClient(config);
  const cwd = process.cwd();
  const context = await buildProjectContext(cwd, title, '');

  const contextText = [
    `## File tree\n\`\`\`\n${context.fileTree}\n\`\`\``,
    ...Object.entries(context.keyFiles).map(
      ([filePath, content]) => `## ${filePath}\n\`\`\`\n${content}\n\`\`\``
    ),
  ].join('\n\n');

  const res = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: `You are a senior engineer writing a task implementation guide.\n\n${GUIDE_FORMAT}`,
      },
      {
        role: 'user',
        content: `Task title: ${title}\n\nProject context:\n${contextText}\n\nWrite the complete implementation guide.`,
      },
    ],
  });

  return res.choices[0].message.content ?? '';
}
