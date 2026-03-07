import chalk from 'chalk';
import { select, input as promptInput } from '@inquirer/prompts';
import type { TechunterConfig } from '../../types.js';

export const definition = {
  type: 'function',
  function: {
    name: 'ask_user',
    description:
      'Ask the user to clarify something ambiguous — scope, expected behaviour, edge cases, or business decisions. ' +
      'Do NOT ask about technical implementation choices. Use at most 3 times per task.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '2–4 concrete answer choices',
        },
      },
      required: ['question', 'options'],
    },
  },
} as const;

export async function execute(input: Record<string, unknown>, _config: TechunterConfig): Promise<string> {
  const question = input['question'] as string;
  const options = input['options'] as string[];
  const OTHER = '__other__';

  console.log('');
  console.log(chalk.dim('  ┌─ Agent question ' + '─'.repeat(51)));
  console.log(chalk.dim('  │'));
  for (const line of question.split('\n')) {
    console.log(chalk.dim('  │ ') + line);
  }
  console.log(chalk.dim('  └' + '─'.repeat(67)));

  let answer: string;
  try {
    const chosen = await select({
      message: ' ',
      choices: [
        ...options.map((o) => ({ name: o, value: o })),
        { name: chalk.dim('Other (describe below)'), value: OTHER },
      ],
    });
    answer = chosen === OTHER ? await promptInput({ message: 'Your answer:' }) : chosen;
  } catch {
    answer = 'User skipped this question — use your best judgement.';
  }

  console.log('');
  return answer;
}
