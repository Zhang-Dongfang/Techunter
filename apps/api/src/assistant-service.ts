import {
  createRepositoryTools,
  runAgentLoop,
  type AgentActivity,
  type AgentChatMessage,
  type AgentChatResponse,
  type AgentTool,
  type Project,
  type Task,
  type User,
} from '@techunter/core';
import { config } from './config.js';
import { GitHubService } from './github-service.js';
import { TaskService } from './task-service.js';
import { httpError } from './errors.js';

export interface AssistantInput {
  message: string;
  history: AgentChatMessage[];
  projectId?: string;
  deviceId?: string;
  deviceLabel?: string;
  user: User;
  modelCredential?: string;
  modelAudience?: string;
  githubCredential?: string;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, 16_000);
}

function taskForAgent(task: Task) {
  return {
    id: task.id,
    shortId: `TH-${task.id.slice(0, 7).toUpperCase()}`,
    title: task.title,
    description: task.description,
    summary: task.summary,
    status: task.status,
    rewardPoints: task.rewardPoints,
    projectId: task.projectId,
    assignee: task.assignee?.login ?? null,
    acceptanceCriteria: task.acceptanceCriteria,
    githubIssueNumber: task.githubIssueNumber,
    workspace: task.workspace?.status ?? null,
  };
}

export class AssistantService {
  constructor(private readonly tasks: TaskService, private readonly github: GitHubService) {}

  async chat(input: AssistantInput): Promise<AgentChatResponse> {
    const value = config();
    const credential = value.ai.accessMode === 'conexus' ? input.modelCredential : value.ai.apiKey;
    if (!credential || (value.ai.accessMode === 'conexus' && !input.modelAudience)) {
      throw httpError(
        value.ai.accessMode === 'conexus' ? 'Techunter Agent 授权已过期，请重新登录。' : 'Task Agent 未配置。',
        value.ai.accessMode === 'conexus' ? 401 : 503,
      );
    }
    const projects = await this.tasks.projects();
    const project = projects.find((candidate) => candidate.id === input.projectId) ?? projects[0];
    if (!project) throw httpError('当前还没有项目，请先从 GitHub 导入。', 400);
    const activities: AgentActivity[] = [];
    const tools = this.taskTools(input, project);
    let checkout: Awaited<ReturnType<GitHubService['materialize']>> | undefined;
    try {
      checkout = await this.github.materialize(project, input.githubCredential).catch(() => undefined);
      if (checkout) tools.push(...createRepositoryTools({ root: checkout.root, allowCommands: false }));
      const reply = await runAgentLoop({
        config: {
          aiApiKey: credential,
          aiAccessMode: value.ai.accessMode,
          aiBaseUrl: value.ai.baseUrl,
          aiModel: value.ai.model,
          ...(input.modelAudience ? { aiAudience: input.modelAudience } : {}),
          ...(value.ai.accessMode === 'conexus' ? { aiPublicationSlug: value.conexus.publicationSlug } : {}),
        },
        systemPrompt: [
          'You are Techunter, an AI task-market assistant backed by the shared control plane.',
          `Current user: ${input.user.name} (@${input.user.login}), role: ${input.user.role}.`,
          `Current project: ${project.name}, repository: ${project.repoOwner}/${project.repoName}.`,
          'Reply in the same language as the user and keep ordinary answers concise.',
          'Use tools for platform state. Never invent IDs, balances, repository facts, or action results.',
          'Only create, claim, or queue work when the user explicitly requests it.',
          'Repository tools are read-only in the central API; environment setup runs on the user device.',
        ].join('\n'),
        history: input.history,
        userMessage: input.message,
        tools,
        hooks: {
          onToolCall(name, toolInput) { activities.push({ name, input: toolInput }); },
          onToolResult(name, result) {
            const activity = [...activities].reverse().find((item) => item.name === name && item.result === undefined);
            if (activity) activity.result = result.slice(0, 2_000);
          },
        },
      });
      return { reply, activities };
    } finally {
      await checkout?.cleanup();
    }
  }

  private taskTools(input: AssistantInput, project: Project): AgentTool[] {
    return [
      {
        definition: {
          type: 'function',
          function: {
            name: 'list_tasks',
            description: 'List shared Techunter tasks.',
            parameters: { type: 'object', properties: { status: { type: 'string' }, mine: { type: 'boolean' }, search: { type: 'string' } } },
          },
        },
        execute: async (toolInput) => json(await this.tasks.listTasks({
          status: typeof toolInput['status'] === 'string' ? toolInput['status'] : undefined,
          assigneeId: toolInput['mine'] === true ? input.user.id : undefined,
          search: typeof toolInput['search'] === 'string' ? toolInput['search'] : undefined,
        })),
      },
      {
        definition: {
          type: 'function',
          function: { name: 'get_task', description: 'Get one task by UUID, TH short ID, or GitHub issue number.', parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
        },
        execute: async (toolInput) => json(taskForAgent(await this.resolveTask(String(toolInput['task_id'] ?? '')))),
      },
      {
        definition: {
          type: 'function',
          function: { name: 'create_task', description: 'Create and analyze a task draft.', parameters: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, project_id: { type: 'string' } }, required: ['title', 'description'] } },
        },
        execute: async (toolInput) => {
          const projectId = typeof toolInput['project_id'] === 'string' ? toolInput['project_id'] : project.id;
          if (!input.githubCredential) throw httpError('创建任务前请先连接 GitHub 账号。', 401);
          await this.tasks.syncProject(projectId, input.user, input.githubCredential);
          const draft = await this.tasks.createDraft({
            projectId,
            title: String(toolInput['title'] ?? ''),
            description: String(toolInput['description'] ?? ''),
            publisherId: input.user.id,
          });
          if (!input.modelCredential || !input.modelAudience) throw httpError('Agent 授权不足，任务草稿已保留。', 401);
          await this.tasks.analyzeTask(draft.id, input.user, { credential: input.modelCredential, audience: input.modelAudience }, input.githubCredential);
          return json(taskForAgent(await this.tasks.getTask(draft.id)));
        },
      },
      {
        definition: {
          type: 'function',
          function: { name: 'claim_task', description: 'Claim an open task.', parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
        },
        execute: async (toolInput) => json(taskForAgent(await this.tasks.claimTask((await this.resolveTask(String(toolInput['task_id'] ?? ''))).id, input.user, input.githubCredential))),
      },
      {
        definition: {
          type: 'function',
          function: { name: 'create_workspace', description: 'Queue the claimed task for environment provisioning on this desktop.', parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
        },
        execute: async (toolInput) => {
          if (!input.deviceId) throw httpError('当前客户端不是可执行本机环境的 Techunter Desktop。', 400);
          const task = await this.resolveTask(String(toolInput['task_id'] ?? ''));
          return json(await this.tasks.createWorkspace(task.id, input.user, { deviceId: input.deviceId, deviceLabel: input.deviceLabel ?? 'Techunter Desktop' }));
        },
      },
    ];
  }

  private async resolveTask(reference: string): Promise<Task> {
    const raw = reference.trim();
    try { return await this.tasks.getTask(raw); } catch { /* short reference below */ }
    const cleaned = raw.replace(/^TH-/i, '').replace(/^#/, '').toLowerCase();
    const candidates = await this.tasks.listTasks();
    const matches: Task[] = [];
    for (const summary of candidates) {
      const task = await this.tasks.getTask(summary.id);
      if (task.id.toLowerCase().startsWith(cleaned) || String(task.githubIssueNumber ?? '') === cleaned) matches.push(task);
    }
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw httpError(`任务 ID ${reference} 不唯一。`, 400);
    throw httpError(`找不到任务：${reference}`, 404);
  }
}
