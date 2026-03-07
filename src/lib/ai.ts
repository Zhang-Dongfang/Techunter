import OpenAI from 'openai';
import { z } from 'zod';
import type { ProjectContext, TaskGuide } from '../types.js';

const taskGuideSchema = z.object({
  summary: z.string(),
  acceptanceCriteria: z.array(z.string()),
  optionalImprovements: z.array(z.string()),
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
  const client = new OpenAI({
    baseURL: 'https://api.ppio.com/openai',
    apiKey,
  });

  const projectInfo = formatProjectContext(projectContext);

  const userPrompt = `${projectInfo}

---

GitHub Issue #${issueNumber}: ${issueTitle}

${issueBody || '(No description provided)'}

---

Generate a concise deliverable guide in JSON format with these exact fields:
- summary (string): one-line task summary
- acceptanceCriteria (string[]): ONLY the critical, verifiable conditions that MUST be met to consider this task done. Each item must be specific and testable. Maximum 5 items.
- optionalImprovements (string[]): nice-to-have enhancements that are not required for delivery. Keep to 3 items max.
- suggestedSteps (string[]): ordered, concrete implementation steps
- filesToModify (string[]): file paths in the project likely to be created or changed

Respond ONLY with valid JSON. No markdown code fences, no explanation, just the JSON object.`;

  const response = await client.chat.completions.create({
    model: 'zai-org/glm-5',
    max_tokens: 2048,
    messages: [
      {
        role: 'system',
        content:
          'You are a senior software architect helping a development team break down tasks into clear, actionable deliverable guides. You have deep knowledge of software engineering best practices and can analyze codebases to provide specific, relevant guidance.',
      },
      {
        role: 'user',
        content: userPrompt,
      },
    ],
  });

  const text = response.choices[0].message.content ?? '';
  if (!text) {
    throw new Error('GLM returned no text response');
  }

  let parsed: unknown;
  try {
    const cleaned = text
      .replace(/^```(?:json)?\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse GLM's response as JSON: ${err}`);
  }

  const result = taskGuideSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`GLM's response didn't match expected schema: ${result.error.message}`);
  }

  return result.data;
}
