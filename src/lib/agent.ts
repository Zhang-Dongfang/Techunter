import Anthropic from '@anthropic-ai/sdk';
import ora from 'ora';
import type { TechunterConfig } from '../types.js';
import {
  listTasks,
  getTask,
  createTask,
  claimTask,
  postGuideComment,
  createPR,
  markInReview,
  getAuthenticatedUser,
  listMyTasks,
  getDefaultBranch,
} from './github.js';
import {
  getCurrentBranch,
  createAndSwitchBranch,
  pushBranch,
  makeBranchName,
} from './git.js';
import { buildProjectContext } from './project.js';
import { generateGuide } from './ai.js';

const tools: Anthropic.Tool[] = [
  {
    name: 'list_tasks',
    description: 'List all available and claimed tasks from GitHub Issues',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_task',
    description: 'Create a new task (GitHub Issue) marked as available',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Task title' },
        body: { type: 'string', description: 'Optional task description' },
      },
      required: ['title'],
    },
  },
  {
    name: 'claim_task',
    description:
      'Claim a task by issue number: generates AI guide, assigns the issue, and creates a git branch',
    input_schema: {
      type: 'object' as const,
      properties: {
        issue_number: {
          type: 'number',
          description: 'The GitHub issue number to claim',
        },
      },
      required: ['issue_number'],
    },
  },
  {
    name: 'deliver_task',
    description:
      'Deliver the current task: push the branch, create a pull request, and mark the issue as in-review',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_my_status',
    description: 'Show tasks currently assigned to the authenticated GitHub user',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  config: TechunterConfig
): Promise<string> {
  try {
    switch (name) {
      case 'list_tasks': {
        const spinner = ora('Loading tasks...').start();
        try {
          const tasks = await listTasks(config);
          spinner.stop();
          if (tasks.length === 0) return 'No tasks found.';
          const lines = tasks.map((t) => {
            const status =
              t.labels.find((l) => l.startsWith('techunter:'))?.replace('techunter:', '') ??
              'unknown';
            const assignee = t.assignee ? `@${t.assignee}` : '—';
            return `  #${t.number}  [${status}]  ${assignee}  ${t.title}`;
          });
          return `Tasks (${tasks.length}):\n${lines.join('\n')}`;
        } catch (err) {
          spinner.stop();
          throw err;
        }
      }

      case 'create_task': {
        const title = input['title'] as string;
        const body = input['body'] as string | undefined;
        const spinner = ora(`Creating task "${title}"...`).start();
        try {
          const issue = await createTask(config, title, body);
          spinner.stop();
          return `Task created: #${issue.number} "${issue.title}" — ${issue.htmlUrl}`;
        } catch (err) {
          spinner.stop();
          throw err;
        }
      }

      case 'claim_task': {
        const issueNumber = input['issue_number'] as number;
        const cwd = process.cwd();

        let spinner = ora(`Fetching issue #${issueNumber}...`).start();
        const [issue, me] = await Promise.all([
          getTask(config, issueNumber),
          getAuthenticatedUser(config),
        ]);
        spinner.stop();

        if (issue.assignee && issue.assignee !== me) {
          return `Issue #${issueNumber} is already claimed by @${issue.assignee}.`;
        }

        spinner = ora('Reading project files...').start();
        const context = await buildProjectContext(cwd, issue.title, issue.body ?? '');
        spinner.stop();

        spinner = ora('Generating task guide with Claude...').start();
        const guide = await generateGuide(
          config.anthropicApiKey,
          context,
          issueNumber,
          issue.title,
          issue.body ?? ''
        );
        spinner.stop();

        spinner = ora('Posting guide to GitHub...').start();
        await postGuideComment(config, issueNumber, guide);
        spinner.stop();

        spinner = ora('Claiming task...').start();
        await claimTask(config, issueNumber, me);
        spinner.stop();

        const branchName = makeBranchName(issueNumber, issue.title);
        spinner = ora(`Creating branch ${branchName}...`).start();
        try {
          await createAndSwitchBranch(branchName);
          spinner.stop();
        } catch {
          spinner.warn(`Could not create branch ${branchName}`);
        }

        spinner = ora(`Pushing branch ${branchName}...`).start();
        try {
          await pushBranch(branchName);
          spinner.stop();
        } catch {
          spinner.warn(`Could not push branch ${branchName}`);
        }

        const stepLines =
          guide.suggestedSteps.length > 0
            ? '\nSteps:\n' +
              guide.suggestedSteps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
            : '';

        return `Task #${issueNumber} claimed! Branch: ${branchName}\nSummary: ${guide.summary}${stepLines}`;
      }

      case 'deliver_task': {
        const branch = await getCurrentBranch();
        const match = branch.match(/^task-(\d+)-/);
        if (!match) {
          return `Current branch "${branch}" doesn't look like a task branch (expected task-N-...).`;
        }
        const issueNumber = parseInt(match[1], 10);

        let spinner = ora('Fetching issue details...').start();
        const [issue, defaultBranch] = await Promise.all([
          getTask(config, issueNumber),
          getDefaultBranch(config),
        ]);
        spinner.stop();

        spinner = ora(`Pushing branch ${branch}...`).start();
        try {
          await pushBranch(branch);
          spinner.stop();
        } catch {
          spinner.warn('Push failed, continuing...');
        }

        spinner = ora('Creating pull request...').start();
        const prUrl = await createPR(
          config,
          issue.title,
          `Closes #${issueNumber}\n\n${issue.body ?? ''}`.trim(),
          branch,
          defaultBranch
        );
        spinner.stop();

        spinner = ora('Marking issue as in-review...').start();
        await markInReview(config, issueNumber);
        spinner.stop();

        return `PR created: ${prUrl}`;
      }

      case 'get_my_status': {
        const spinner = ora('Fetching your tasks...').start();
        const me = await getAuthenticatedUser(config);
        const tasks = await listMyTasks(config, me);
        spinner.stop();

        if (tasks.length === 0) return `No tasks currently assigned to @${me}.`;
        const lines = tasks.map((t) => {
          const status =
            t.labels.find((l) => l.startsWith('techunter:'))?.replace('techunter:', '') ??
            'unknown';
          return `  #${t.number}  [${status}]  ${t.title}`;
        });
        return `Tasks assigned to @${me}:\n${lines.join('\n')}`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

export async function runAgentLoop(
  config: TechunterConfig,
  messages: Anthropic.MessageParam[]
): Promise<string> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const { owner, repo } = config.github;

  const systemPrompt = [
    'You are Techunter, an AI assistant managing GitHub tasks for a development team.',
    `Repository: ${owner}/${repo}`,
    'Respond in the same language the user writes in (Chinese or English).',
    'Be concise and action-oriented. Always use tools when the user requests an action.',
  ].join('\n');

  for (;;) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });

    // Mutate caller's array so full conversation history is preserved
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find((b) => b.type === 'text');
      return textBlock?.type === 'text' ? textBlock.text : '';
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      );

      // Execute all tool calls (in parallel where safe)
      const results = await Promise.all(
        toolUseBlocks.map((block) =>
          executeTool(block.name, block.input as Record<string, unknown>, config)
        )
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block, i) => ({
        type: 'tool_result' as const,
        tool_use_id: block.id,
        content: results[i],
      }));

      messages.push({ role: 'user', content: toolResults });
      // Loop continues for next Claude response
    } else {
      // Unexpected stop reason — return whatever text we have
      const textBlock = response.content.find((b) => b.type === 'text');
      return textBlock?.type === 'text' ? textBlock.text : '';
    }
  }
}
