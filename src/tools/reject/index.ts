import chalk from 'chalk';
import { select, input as promptInput } from '@inquirer/prompts';
import ora from 'ora';
import type { TechunterConfig } from '../../types.js';
import { postComment, rejectTask } from '../../lib/github.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { generateRejectionComment } from './comment-generator.js';

export const definition = {
  type: 'function',
  function: {
    name: 'reject',
    description:
      'Reject an in-review task: collects reviewer feedback, generates a structured rejection comment, ' +
      'shows a preview for confirmation, then posts the comment and marks the issue as changes-needed.',
    parameters: {
      type: 'object',
      properties: {
        issue_number: { type: 'number', description: 'GitHub issue number to reject' },
      },
      required: ['issue_number'],
    },
  },
} as const;

export async function run(config: TechunterConfig, opts: { issue_number: number }): Promise<string> {
  const { issue_number: issueNumber } = opts;

  let feedback: string;
  try {
    feedback = await promptInput({
      message: `What's wrong with #${issueNumber}? (brief description for the reviewer agent)`,
    });
  } catch {
    return 'Cancelled.';
  }
  if (!feedback.trim()) return 'Cancelled.';

  const divider = chalk.dim('─'.repeat(70));

  for (;;) {
    const spinner = ora('Generating rejection comment…').start();
    let comment: string;
    try {
      comment = await generateRejectionComment(config, issueNumber, feedback);
      spinner.stop();
    } catch (err) {
      spinner.stop();
      return `Error generating comment: ${(err as Error).message}`;
    }

    console.log('\n' + divider);
    console.log(chalk.bold(`  Rejection preview — issue #${issueNumber}`));
    console.log(divider);
    console.log(renderMarkdown(comment));
    console.log(divider + '\n');

    let decision: string;
    try {
      decision = await select({
        message: `Post rejection and mark #${issueNumber} as changes-needed?`,
        choices: [
          { name: 'Post & Reject', value: 'yes' },
          { name: 'Revise — describe what to change', value: 'revise' },
          { name: 'Cancel', value: 'cancel' },
        ],
      });
    } catch {
      return 'Cancelled.';
    }

    if (decision === 'cancel') return 'User cancelled rejection.';

    if (decision === 'revise') {
      try {
        feedback = await promptInput({ message: 'What should be changed?' });
      } catch {
        return 'Cancelled.';
      }
      continue;
    }

    // decision === 'yes'
    let spinner2 = ora(`Posting rejection comment on #${issueNumber}…`).start();
    try {
      await postComment(config, issueNumber, comment);
      spinner2.stop();
    } catch (err) {
      spinner2.stop();
      return `Error posting comment: ${(err as Error).message}`;
    }

    spinner2 = ora(`Marking #${issueNumber} as changes-needed…`).start();
    try {
      await rejectTask(config, issueNumber);
      spinner2.stop();
    } catch (err) {
      spinner2.stop();
      return `Comment posted but failed to update label: ${(err as Error).message}`;
    }

    return `Task #${issueNumber} rejected. Label changed to changes-needed.`;
  }
}

export const execute = (input: Record<string, unknown>, config: TechunterConfig) =>
  run(config, { issue_number: input['issue_number'] as number });
