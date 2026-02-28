import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { ProjectContext, TaskGuide } from '../types.js';

const taskGuideSchema = z.object({
  summary: z.string(),
  context: z.string(),
  prerequisites: z.array(z.string()),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  suggestedSteps: z.array(z.string()),
  filesToModify: z.array(z.string()),
});

function formatProjectContext(ctx: ProjectContext): string {
  const parts: string[] = [];

  parts.push('### Project File Tree\n```\n' + ctx.fileTree + '\n```');

  if (Object.keys(ctx.keyFiles).length > 0) {
    parts.push('\n### Key Project Files\n');
    for (const [filePath, content] of Object.entries(ctx.keyFiles)) {
      parts.push(`**${filePath}**\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  return parts.join('\n\n');
}

export async function generateGuide(
  apiKey: string,
  projectContext: ProjectContext,
  issueNumber: number,
  issueTitle: string,
  issueBody: string
): Promise<TaskGuide> {
  const client = new Anthropic({ apiKey });

  const projectInfo = formatProjectContext(projectContext);

  const userPrompt = `${projectInfo}

---

GitHub Issue #${issueNumber}: ${issueTitle}

${issueBody || '(No description provided)'}

---

Generate a deliverable guide in JSON format with these exact fields:
- summary (string): one-line task summary
- context (string): how this task fits in the project architecture
- prerequisites (string[]): what must be done or understood before starting
- inputs (string[]): data, APIs, files, or services the developer will work with
- outputs (string[]): concrete artifacts to produce (files, endpoints, functions, etc.)
- acceptanceCriteria (string[]): specific, testable conditions to verify completion
- suggestedSteps (string[]): ordered, concrete implementation steps
- filesToModify (string[]): file paths in the project likely to be created or changed

Respond ONLY with valid JSON. No markdown code fences, no explanation, just the JSON object.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system:
      'You are a senior software architect helping a development team break down tasks into clear, actionable deliverable guides. You have deep knowledge of software engineering best practices and can analyze codebases to provide specific, relevant guidance.',
    messages: [
      {
        role: 'user',
        content: userPrompt,
      },
    ],
  });

  const textBlock = message.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text response');
  }

  let parsed: unknown;
  try {
    // Strip any accidental markdown fences
    const cleaned = textBlock.text
      .replace(/^```(?:json)?\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse Claude's response as JSON: ${err}`);
  }

  const result = taskGuideSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Claude's response didn't match expected schema: ${result.error.message}`);
  }

  return result.data;
}
