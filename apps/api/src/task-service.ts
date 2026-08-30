import { minimatch } from 'minimatch';
import {
  type DashboardResponse,
  type GitHubBranch,
  type GitHubRepositoryCandidate,
  type LedgerEntry,
  type PackageFile,
  type Project,
  type Submission,
  type Task,
  type TaskAnalysis,
  type TaskScope,
  type TaskSummary,
  type User,
  type Workspace,
} from '@techunter/core';
import { AgentService } from './agent-service.js';
import { config } from './config.js';
import { database, dataOrThrow } from './database.js';
import { httpError, translateDatabaseError } from './errors.js';
import { GitHubService } from './github-service.js';
import { resolveTaskVersion } from './task-version.js';

type Row = Record<string, any>;

function jsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value as T;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function matches(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern, { dot: true, nocase: process.platform === 'win32' }));
}

function normalizePackageFiles(files: PackageFile[], scope: TaskScope): PackageFile[] {
  const unique = new Set<string>();
  let totalBytes = 0;
  return files.map((file) => {
    const normalized = file.path.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!normalized || normalized === '..' || normalized.startsWith('/') || normalized.includes('../')) {
      throw httpError(`非法提交路径：${file.path}`, 400);
    }
    if (unique.has(normalized)) throw httpError(`提交包含重复路径：${normalized}`, 400);
    unique.add(normalized);
    if (!matches(normalized, scope.editablePaths) || matches(normalized, scope.deniedPaths)) {
      throw httpError(`提交文件超出 editablePaths：${normalized}`, 400);
    }
    if (file.encoding !== 'utf-8' && file.encoding !== 'base64') throw httpError(`不支持的文件编码：${normalized}`, 400);
    const bytes = file.content === null ? 0 : Buffer.byteLength(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
    if (bytes > 2 * 1024 * 1024) throw httpError(`单个提交文件超过 2 MiB：${normalized}`, 400);
    totalBytes += bytes;
    if (totalBytes > 15 * 1024 * 1024) throw httpError('本次提交超过 15 MiB。', 400);
    return { ...file, path: normalized };
  });
}

export class TaskService {
  constructor(
    private readonly github: GitHubService,
    private readonly agent: AgentService,
  ) {}

  async projects(): Promise<Project[]> {
    const rows = dataOrThrow(await database().from('projects').select('*').order('name')) as Row[];
    return Promise.all(rows.map((row) => this.projectFromRow(row)));
  }

  async importProject(repository: GitHubRepositoryCandidate & { headSha: string }, actor: User): Promise<Project> {
    if (!repository.permissions.pull) throw httpError('当前 GitHub 账号没有读取该仓库的权限。', 403);
    const payload = {
      github_repository_id: repository.githubRepositoryId,
      name: repository.name,
      description: repository.description,
      repo_owner: repository.owner,
      repo_name: repository.name,
      clone_url: repository.cloneUrl,
      html_url: repository.htmlUrl,
      default_branch: repository.defaultBranch,
      source_branch: repository.defaultBranch,
      visibility: repository.visibility,
      head_sha: repository.headSha,
      imported_by: actor.id,
    };
    const existing = await database().from('projects').select('id').eq('github_repository_id', repository.githubRepositoryId).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    let row: Row;
    if (existing.data) {
      row = dataOrThrow(await database().from('projects').update(payload).eq('id', existing.data.id).select('*').single()) as Row;
    } else {
      row = dataOrThrow(await database().from('projects').insert(payload).select('*').single()) as Row;
      const allocation = await database().rpc('allocate_project_points', {
        p_project_id: row['id'],
        p_amount: config().initialProjectPoints,
      });
      if (allocation.error) throw new Error(allocation.error.message);
    }
    await this.audit(actor.id, 'project.imported', 'project', String(row['id']), { githubRepositoryId: repository.githubRepositoryId });
    return this.projectFromRow(row);
  }

  async syncProject(projectId: string, actor: User, githubCredential: string): Promise<Project> {
    const current = await this.getProject(projectId);
    const repository = await this.github.repository(current.githubRepositoryId, githubCredential, current.sourceBranch);
    const update = await database().from('projects').update({
      name: repository.name,
      description: repository.description,
      repo_owner: repository.owner,
      repo_name: repository.name,
      clone_url: repository.cloneUrl,
      html_url: repository.htmlUrl,
      default_branch: repository.defaultBranch,
      source_branch: current.sourceBranch,
      visibility: repository.visibility,
      head_sha: repository.headSha,
    }).eq('id', projectId).select('*').single();
    if (update.error) throw new Error(update.error.message);
    await this.audit(actor.id, 'project.synced', 'project', projectId, { sourceBranch: current.sourceBranch, headSha: repository.headSha });
    return this.projectFromRow(update.data as Row);
  }

  async projectBranches(projectId: string, githubCredential: string): Promise<{ branches: GitHubBranch[]; sourceBranch: string }> {
    const project = await this.getProject(projectId);
    return {
      branches: await this.github.listBranches(project.githubRepositoryId, githubCredential),
      sourceBranch: project.sourceBranch,
    };
  }

  async switchProjectBranch(projectId: string, sourceBranch: string, actor: User, githubCredential: string): Promise<Project> {
    const current = await this.getProject(projectId);
    const branch = sourceBranch.trim();
    const repository = await this.github.repository(current.githubRepositoryId, githubCredential, branch);
    if (!repository.permissions.pull) throw httpError('当前 GitHub 账号没有读取该仓库的权限。', 403);
    const update = await database().from('projects').update({
      name: repository.name,
      description: repository.description,
      repo_owner: repository.owner,
      repo_name: repository.name,
      clone_url: repository.cloneUrl,
      html_url: repository.htmlUrl,
      default_branch: repository.defaultBranch,
      source_branch: branch,
      visibility: repository.visibility,
      head_sha: repository.headSha,
    }).eq('id', projectId).select('*').single();
    if (update.error) throw new Error(update.error.message);
    await this.audit(actor.id, 'project.branch_switched', 'project', projectId, {
      previousBranch: current.sourceBranch,
      sourceBranch: branch,
      headSha: repository.headSha,
    });
    return this.projectFromRow(update.data as Row);
  }

  async requestProjectCollaboration(projectId: string, actor: User, githubCredential: string): Promise<{ status: 'invited' | 'already_collaborator'; actionUrl: string }> {
    if (!actor.githubLogin) throw httpError('提交合作者申请前请先连接 GitHub 账号。', 401, 'GITHUB_ACCOUNT_REQUIRED');
    const project = await this.getProject(projectId);
    if (project.visibility === 'public') throw httpError('公开仓库不需要申请合作者权限。', 400);
    const result = await this.github.requestCollaboration(project, actor.githubLogin, githubCredential);
    await this.audit(actor.id, 'project.collaboration_requested', 'project', projectId, {
      githubLogin: actor.githubLogin,
      result: result.status,
    });
    return result;
  }

  async dashboard(me: User): Promise<Omit<DashboardResponse, 'runtime'>> {
    const [projects, tasks, points, reviewSubmissions] = await Promise.all([
      this.projects(),
      this.listTasks(),
      this.balance('user', me.id),
      database().from('submissions').select('task_id').eq('status', 'approved'),
    ]);
    if (reviewSubmissions.error) throw new Error(reviewSubmissions.error.message);
    const reviewIds = [...new Set((reviewSubmissions.data ?? []).map((row: Row) => String(row['task_id'])))];
    let reviewCount = 0;
    if (reviewIds.length) {
      const reviewTasks = await database().from('tasks').select('id').in('id', reviewIds).eq('status', 'submitted').neq('assignee_id', me.id);
      if (reviewTasks.error) throw new Error(reviewTasks.error.message);
      reviewCount = reviewTasks.data.length;
    }
    return { me, projects, tasks, myAvailablePoints: points, reviewCount };
  }

  async listTasks(filters: { status?: string; assigneeId?: string; search?: string } = {}): Promise<TaskSummary[]> {
    let query = database().from('tasks').select('*').order('updated_at', { ascending: false });
    if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status);
    else query = query.neq('status', 'cancelled');
    if (filters.assigneeId) query = query.eq('assignee_id', filters.assigneeId);
    if (filters.search) query = query.or(`title.ilike.%${filters.search.replaceAll(',', '')}%,description.ilike.%${filters.search.replaceAll(',', '')}%`);
    const rows = dataOrThrow(await query) as Row[];
    const summaries = await Promise.all(rows.map((row) => this.summaryFromRow(row)));
    const order: Record<string, number> = { active: 0, open: 1, submitted: 2 };
    return summaries.sort((left, right) => (order[left.status] ?? 3) - (order[right.status] ?? 3) || right.updatedAt.localeCompare(left.updatedAt));
  }

  async getTask(id: string): Promise<Task> {
    const row = await this.taskRow(id);
    const [project, publisher, assignee, reviewer, workspaceResult, submissionResult, childrenResult] = await Promise.all([
      this.getProject(String(row['project_id'])),
      this.getUser(String(row['publisher_id'])),
      row['assignee_id'] ? this.getUser(String(row['assignee_id'])) : Promise.resolve(null),
      row['reviewer_id'] ? this.getUser(String(row['reviewer_id'])) : Promise.resolve(null),
      database().from('workspaces').select('*').eq('task_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      database().from('submissions').select('*').eq('task_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      database().from('tasks').select('*').eq('parent_task_id', id).order('created_at'),
    ]);
    if (workspaceResult.error) throw new Error(workspaceResult.error.message);
    if (submissionResult.error) throw new Error(submissionResult.error.message);
    if (childrenResult.error) throw new Error(childrenResult.error.message);
    const scope = jsonValue<TaskScope | null>(row['scope_json'], null);
    const acceptanceCriteria = jsonValue<string[]>(row['acceptance_json'], []);
    const analysis = jsonValue<TaskAnalysis | null>(row['analysis_json'], null);
    const effectiveAnalysis = analysis ?? (scope ? {
      summary: String(row['summary'] || row['description']),
      acceptanceCriteria,
      scope,
      suggestedPoints: Number(row['reward_points']),
      confidence: 'low' as const,
      rationale: '该任务来自早期数据。',
    } : null);
    return {
      id: String(row['id']),
      projectId: project.id,
      projectName: project.name,
      parentTaskId: row['parent_task_id'] ? String(row['parent_task_id']) : null,
      rootTaskId: row['root_task_id'] ? String(row['root_task_id']) : null,
      title: String(row['title']),
      description: String(row['description']),
      summary: String(row['summary']),
      acceptanceCriteria,
      status: row['status'] as Task['status'],
      rewardPoints: Number(row['reward_points']),
      publisher,
      assignee,
      reviewer,
      baseSha: String(row['base_sha']),
      targetBranch: String(row['target_branch']),
      githubIssueNumber: row['github_issue_number'] === null ? null : Number(row['github_issue_number']),
      githubIssueUrl: row['github_issue_url'] ? String(row['github_issue_url']) : null,
      analysis: effectiveAnalysis,
      scope,
      workspace: workspaceResult.data ? this.workspaceFromRow(workspaceResult.data as Row) : null,
      latestSubmission: submissionResult.data ? await this.submissionFromRow(submissionResult.data as Row) : null,
      children: await Promise.all(((childrenResult.data ?? []) as Row[]).map((child) => this.summaryFromRow(child))),
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    };
  }

  async createDraft(input: { projectId: string; title: string; description: string; publisherId: string; parentTaskId?: string | null }, githubCredential: string): Promise<Task> {
    const project = await this.getProject(input.projectId);
    let parent: Task | null = null;
    if (input.parentTaskId) {
      parent = await this.getTask(input.parentTaskId);
      if (parent.projectId !== input.projectId) throw httpError('子任务必须与父任务属于同一项目。', 400);
      if (!['active', 'submitted'].includes(parent.status)) throw httpError('只有进行中的任务可以创建子任务。', 400);
      if (parent.githubIssueNumber === null || !parent.assignee?.githubLogin) throw httpError('母任务还没有可同步的远程任务分支。', 409);
    }
    const version = await resolveTaskVersion(project, parent, async (parentBranch) => {
      if (!parent?.assignee?.githubLogin) throw httpError('母任务还没有可同步的远程任务分支。', 409);
      const branch = await this.github.ensureTaskBranch(parent, project, parent.assignee.githubLogin, githubCredential);
      if (branch.name !== parentBranch) throw new Error('母任务分支解析不一致。');
      return branch.headSha;
    });
    const row = dataOrThrow(await database().from('tasks').insert({
      project_id: project.id,
      parent_task_id: parent?.id ?? null,
      root_task_id: parent ? (parent.rootTaskId ?? parent.id) : null,
      title: input.title.trim(),
      description: input.description.trim(),
      publisher_id: input.publisherId,
      base_sha: version.baseSha,
      target_branch: version.targetBranch,
    }).select('id').single()) as Row;
    await this.audit(input.publisherId, 'task.created', 'task', String(row['id']), { parentTaskId: parent?.id ?? null });
    return this.getTask(String(row['id']));
  }

  async analyzeTask(taskId: string, actor: User, authorization?: { credential: string; audience: string }, githubCredential?: string): Promise<TaskAnalysis> {
    const task = await this.getTask(taskId);
    if (task.status !== 'draft') throw httpError('只有草稿任务可以重新分析。', 400);
    if (task.publisher.id !== actor.id && actor.role !== 'admin') throw httpError('当前账号没有分析该任务的权限。', 403);
    const [project, parent] = await Promise.all([
      this.getProject(task.projectId),
      task.parentTaskId ? this.getTask(task.parentTaskId) : Promise.resolve(null),
    ]);
    const analysis = await this.agent.analyze({
      title: task.title,
      description: task.description,
      project,
      githubCredential,
      editableLimit: parent?.scope?.editablePaths,
      readonlyLimit: parent?.scope ? [...parent.scope.editablePaths, ...parent.scope.readonlyPaths] : undefined,
      inheritedDeniedPaths: parent?.scope?.deniedPaths,
      modelCredential: authorization?.credential,
      modelAudience: authorization?.audience,
    });
    const update = await database().from('tasks').update({
      summary: analysis.summary,
      acceptance_json: analysis.acceptanceCriteria,
      scope_json: analysis.scope,
      analysis_json: analysis,
      reward_points: analysis.suggestedPoints,
    }).eq('id', taskId);
    if (update.error) throw new Error(update.error.message);
    await this.audit(actor.id, 'task.analyzed', 'task', taskId, { confidence: analysis.confidence });
    return analysis;
  }

  async publishTask(taskId: string, actor: User, rewardPoints: number | undefined, githubCredential?: string): Promise<Task> {
    const task = await this.getTask(taskId);
    if (task.status !== 'draft' || !task.scope) throw httpError('只有完成分析的草稿可以发布。', 400);
    const reward = rewardPoints ?? task.analysis?.suggestedPoints ?? task.rewardPoints;
    const project = await this.getProject(task.projectId);
    const issue = await this.github.createIssue({ ...task, rewardPoints: reward }, project, githubCredential);
    const result = await database().rpc('publish_task', {
      p_task_id: taskId,
      p_actor_id: actor.id,
      p_reward: reward,
      p_issue_number: issue.number,
      p_issue_url: issue.url,
    });
    if (result.error) translateDatabaseError(new Error(result.error.message));
    return this.getTask(taskId);
  }

  async removeTask(taskId: string, actor: User, githubCredential?: string): Promise<{ id: string; disposition: 'deleted' | 'cancelled' }> {
    if (actor.role !== 'admin') throw httpError('只有管理员可以删除任务。', 403);
    const task = await this.getTask(taskId);
    if (task.status === 'accepted') throw httpError('已验收结算的任务不能删除。', 409, 'TASK_ALREADY_SETTLED');
    if (task.status === 'cancelled') throw httpError('任务已经被取消。', 409, 'TASK_ALREADY_CANCELLED');

    if (task.status !== 'draft') {
      const children = await database().from('tasks').select('id').eq('parent_task_id', taskId).not('status', 'in', '(accepted,cancelled)');
      if (children.error) throw new Error(children.error.message);
      if (children.data.length) throw httpError(`还有 ${children.data.length} 个未完成子任务，不能移除父任务。`, 409, 'OPEN_CHILD_TASKS');
      await this.github.cancelTask(task, await this.getProject(task.projectId), githubCredential);
    }

    const result = await database().rpc('admin_remove_task', { p_task_id: taskId, p_actor_id: actor.id });
    if (result.error) translateDatabaseError(new Error(result.error.message));
    const disposition = result.data === 'deleted' ? 'deleted' : 'cancelled';
    return { id: taskId, disposition };
  }

  async claimTask(taskId: string, user: User, githubCredential?: string): Promise<Task> {
    if (!user.githubLogin || !githubCredential) throw httpError('认领任务前请先连接 GitHub 账号。', 400);
    const result = await database().rpc('claim_task', { p_task_id: taskId, p_user_id: user.id });
    if (result.error) translateDatabaseError(new Error(result.error.message));
    const task = await this.getTask(taskId);
    const project = await this.getProject(task.projectId);
    try {
      await this.github.syncClaim(task, project, user.githubLogin, githubCredential);
    } catch (error) {
      await database().rpc('rollback_claim', { p_task_id: taskId, p_user_id: user.id, p_reason: (error as Error).message });
      throw error;
    }
    return task;
  }

  async releaseTask(taskId: string, user: User, githubCredential?: string): Promise<Task> {
    const task = await this.getTask(taskId);
    if (task.status !== 'active' || task.assignee?.id !== user.id) throw httpError('只能释放自己正在执行的任务。', 400);
    const result = await database().rpc('release_task', { p_task_id: taskId, p_user_id: user.id });
    if (result.error) translateDatabaseError(new Error(result.error.message));
    await this.github.syncRelease(task, await this.getProject(task.projectId), githubCredential);
    return this.getTask(taskId);
  }

  async createWorkspace(taskId: string, user: User, device: { deviceId: string; deviceLabel: string }): Promise<Workspace> {
    const task = await this.getTask(taskId);
    if (task.assignee?.id !== user.id && user.role !== 'admin') throw httpError('当前账号不能创建这个工作环境。', 403);
    if (task.status !== 'active' || !task.scope) throw httpError('只有进行中的有效任务可以创建工作环境。', 400);
    const existing = await database().from('workspaces').select('*').eq('task_id', taskId).eq('device_id', device.deviceId)
      .in('status', ['queued', 'provisioning', 'running']).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) return this.workspaceFromRow(existing.data as Row);
    const row = dataOrThrow(await database().from('workspaces').insert({
      task_id: taskId,
      user_id: user.id,
      status: 'queued',
      provider: 'local_agent',
      device_id: device.deviceId,
      device_label: device.deviceLabel,
    }).select('*').single()) as Row;
    await this.audit(user.id, 'workspace.queued', 'workspace', String(row['id']), { taskId, deviceId: device.deviceId });
    return this.workspaceFromRow(row);
  }

  async updateWorkspace(workspaceId: string, user: User, input: { status: 'provisioning' | 'running' | 'failed'; headSha?: string; setupLog?: string; error?: string | null }): Promise<Workspace> {
    const existing = dataOrThrow(await database().from('workspaces').select('*').eq('id', workspaceId).single()) as Row;
    if (String(existing['user_id']) !== user.id && user.role !== 'admin') throw httpError('当前账号不能更新这个工作环境。', 403);
    const row = dataOrThrow(await database().from('workspaces').update({
      status: input.status,
      head_sha: input.headSha ?? existing['head_sha'],
      setup_log: (input.setupLog ?? existing['setup_log'] ?? '').slice(0, 100_000),
      error: input.error ?? null,
    }).eq('id', workspaceId).select('*').single()) as Row;
    await this.audit(user.id, `workspace.${input.status}`, 'workspace', workspaceId, { taskId: row['task_id'], deviceId: row['device_id'] });
    return this.workspaceFromRow(row);
  }

  async submitTask(taskId: string, user: User, input: { summary: string; testOutput: string; files: PackageFile[] }, authorization?: { credential: string; audience: string }, githubCredential?: string): Promise<Submission> {
    const task = await this.getTask(taskId);
    if (task.status !== 'active' || task.assignee?.id !== user.id || !task.scope) throw httpError('只有任务执行者可以提交进行中的任务。', 400);
    const children = dataOrThrow(await database().from('tasks').select('id').eq('parent_task_id', taskId).not('status', 'in', '(accepted,cancelled)')) as Row[];
    if (children.length) throw httpError(`还有 ${children.length} 个子任务未完成。`, 400);
    if (task.workspace?.status !== 'running') throw httpError('本机工作环境尚未准备完成。', 400);
    const files = normalizePackageFiles(input.files, task.scope);
    if (!files.length) throw httpError('editablePaths 范围内没有检测到任何改动。', 400);
    const row = dataOrThrow(await database().from('submissions').insert({
      task_id: taskId,
      author_id: user.id,
      status: 'reviewing',
      summary: input.summary.trim(),
      test_output: input.testOutput.trim(),
      files_json: files,
    }).select('*').single()) as Row;
    const markSubmitted = await database().from('tasks').update({ status: 'submitted', lock_version: Number((await this.taskRow(taskId))['lock_version']) + 1 }).eq('id', taskId);
    if (markSubmitted.error) throw new Error(markSubmitted.error.message);
    const review = await this.agent.review({
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      changedFiles: files,
      testOutput: input.testOutput,
      summary: input.summary,
      modelCredential: authorization?.credential,
      modelAudience: authorization?.audience,
    });
    const status = review.verdict === 'approved' ? 'approved' : 'changes_requested';
    const project = await this.getProject(task.projectId);
    try {
      const pullUrl = await this.github.publishSubmission({ ...task, status: 'submitted' }, project, files, review, githubCredential);
      const update = await database().from('submissions').update({ status, review_json: review, pull_request_url: pullUrl }).eq('id', row['id']);
      if (update.error) throw new Error(update.error.message);
      if (status === 'changes_requested') await database().from('tasks').update({ status: 'active' }).eq('id', taskId);
    } catch (error) {
      await Promise.all([
        database().from('submissions').update({ status: 'changes_requested', review_json: review }).eq('id', row['id']),
        database().from('tasks').update({ status: 'active' }).eq('id', taskId),
      ]);
      throw error;
    }
    await this.audit(user.id, 'submission.created', 'submission', String(row['id']), { taskId, changedFiles: files.map((file) => file.path) });
    return this.getSubmission(String(row['id']));
  }

  async acceptSubmission(submissionId: string, reviewer: User, githubCredential?: string): Promise<Task> {
    const submission = await this.getSubmission(submissionId);
    const task = await this.getTask(submission.taskId);
    if (submission.status !== 'approved' || task.status !== 'submitted') throw httpError('只有通过预审的待验收提交可以验收。', 400);
    if (task.assignee?.id === reviewer.id) throw httpError('执行者不能验收自己的任务。', 403);
    await this.github.completeTask(task, await this.getProject(task.projectId), submission.pullRequestUrl, githubCredential);
    const result = await database().rpc('accept_task', { p_submission_id: submissionId, p_reviewer_id: reviewer.id });
    if (result.error) translateDatabaseError(new Error(result.error.message));
    return this.getTask(task.id);
  }

  async requestChanges(submissionId: string, reviewer: User, reason: string, githubCredential?: string): Promise<Task> {
    const submission = await this.getSubmission(submissionId);
    const task = await this.getTask(submission.taskId);
    if (task.assignee?.id === reviewer.id) throw httpError('执行者不能审核自己的任务。', 403);
    await this.github.syncChangesNeeded(task, await this.getProject(task.projectId), reason, githubCredential);
    const [submissionUpdate, taskUpdate] = await Promise.all([
      database().from('submissions').update({ status: 'changes_requested' }).eq('id', submissionId),
      database().from('tasks').update({ status: 'active' }).eq('id', task.id),
    ]);
    if (submissionUpdate.error) throw new Error(submissionUpdate.error.message);
    if (taskUpdate.error) throw new Error(taskUpdate.error.message);
    await this.audit(reviewer.id, 'submission.changes_requested', 'submission', submissionId, { reason });
    return this.getTask(task.id);
  }

  async getSubmission(id: string): Promise<Submission> {
    const row = dataOrThrow(await database().from('submissions').select('*').eq('id', id).single()) as Row;
    return this.submissionFromRow(row);
  }

  async points(userId: string): Promise<{ available: number; reserved: number; entries: LedgerEntry[] }> {
    const [available, reserved, accounts] = await Promise.all([
      this.balance('user', userId, 'available'),
      this.balance('user', userId, 'reserved'),
      database().from('point_accounts').select('id').eq('owner_type', 'user').eq('owner_id', userId),
    ]);
    if (accounts.error) throw new Error(accounts.error.message);
    const ids = (accounts.data ?? []).map((row: Row) => row['id']);
    if (!ids.length) return { available, reserved, entries: [] };
    const transfers = dataOrThrow(await database().from('point_transfers').select('*').or(`from_account_id.in.(${ids.join(',')}),to_account_id.in.(${ids.join(',')})`).order('created_at', { ascending: false }).limit(100)) as Row[];
    const entries = await Promise.all(transfers.map(async (row) => {
      const [source, destination] = await Promise.all([
        database().from('point_accounts').select('label').eq('id', row['from_account_id']).single(),
        database().from('point_accounts').select('label').eq('id', row['to_account_id']).single(),
      ]);
      if (source.error || destination.error) throw new Error(source.error?.message ?? destination.error?.message);
      return {
        id: String(row['id']), type: String(row['type']), amount: Number(row['amount']),
        fromLabel: String(source.data.label), toLabel: String(destination.data.label),
        taskId: row['task_id'] ? String(row['task_id']) : null,
        memo: String(row['memo']), createdAt: String(row['created_at']),
      } satisfies LedgerEntry;
    }));
    return { available, reserved, entries };
  }

  async auditEvents(): Promise<Row[]> {
    return dataOrThrow(await database().from('audit_events').select('*').order('created_at', { ascending: false }).limit(200)) as Row[];
  }

  private async taskRow(id: string): Promise<Row> {
    const result = await database().from('tasks').select('*').eq('id', id).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw httpError('任务不存在。', 404);
    return result.data as Row;
  }

  async getProject(id: string): Promise<Project> {
    const result = await database().from('projects').select('*').eq('id', id).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw httpError('项目不存在。', 404);
    return this.projectFromRow(result.data as Row);
  }

  private async projectFromRow(row: Row): Promise<Project> {
    return {
      id: String(row['id']),
      githubRepositoryId: Number(row['github_repository_id']),
      name: String(row['name']),
      description: String(row['description']),
      repoOwner: String(row['repo_owner']),
      repoName: String(row['repo_name']),
      cloneUrl: String(row['clone_url']),
      htmlUrl: String(row['html_url']),
      defaultBranch: String(row['default_branch']),
      sourceBranch: String(row['source_branch'] ?? row['default_branch']),
      visibility: row['visibility'] as Project['visibility'],
      headSha: String(row['head_sha']),
      availablePoints: await this.balance('project', String(row['id'])),
      importedBy: row['imported_by'] ? await this.getUser(String(row['imported_by'])) : null,
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    };
  }

  private async getUser(id: string): Promise<User> {
    const result = await database().from('users').select('*').eq('id', id).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw httpError('用户不存在。', 404);
    const row = result.data as Row;
    return {
      id: String(row['id']), login: String(row['login']), name: String(row['name']),
      avatarUrl: row['avatar_url'] ? String(row['avatar_url']) : null,
      email: row['email'] ? String(row['email']) : null,
      githubLogin: row['github_login'] ? String(row['github_login']) : null,
      role: row['role'] as User['role'],
    };
  }

  private async summaryFromRow(row: Row): Promise<TaskSummary> {
    const [project, publisher, assignee] = await Promise.all([
      this.getProject(String(row['project_id'])),
      this.getUser(String(row['publisher_id'])),
      row['assignee_id'] ? this.getUser(String(row['assignee_id'])) : Promise.resolve(null),
    ]);
    return {
      id: String(row['id']), projectId: project.id, projectName: project.name,
      parentTaskId: row['parent_task_id'] ? String(row['parent_task_id']) : null,
      title: String(row['title']), summary: String(row['summary'] || row['description']),
      status: row['status'] as TaskSummary['status'], rewardPoints: Number(row['reward_points']),
      publisher, assignee, createdAt: String(row['created_at']), updatedAt: String(row['updated_at']),
    };
  }

  private workspaceFromRow(row: Row): Workspace {
    return {
      id: String(row['id']), taskId: String(row['task_id']), status: row['status'] as Workspace['status'],
      provider: 'local_agent', deviceId: String(row['device_id']), deviceLabel: String(row['device_label']),
      headSha: String(row['head_sha'] ?? ''), setupLog: String(row['setup_log'] ?? ''),
      error: row['error'] ? String(row['error']) : null,
      createdAt: String(row['created_at']), updatedAt: String(row['updated_at']),
    };
  }

  private async submissionFromRow(row: Row): Promise<Submission> {
    return {
      id: String(row['id']), taskId: String(row['task_id']), author: await this.getUser(String(row['author_id'])),
      status: row['status'] as Submission['status'], summary: String(row['summary']), testOutput: String(row['test_output']),
      pullRequestUrl: row['pull_request_url'] ? String(row['pull_request_url']) : null,
      review: jsonValue(row['review_json'], null), createdAt: String(row['created_at']), updatedAt: String(row['updated_at']),
    };
  }

  private async balance(ownerType: 'project' | 'user', ownerId: string, bucket: 'available' | 'reserved' = 'available'): Promise<number> {
    const result = await database().from('point_accounts').select('balance').eq('owner_type', ownerType).eq('owner_id', ownerId).eq('bucket', bucket).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return Number(result.data?.balance ?? 0);
  }

  private async audit(actorId: string | null, action: string, entityType: string, entityId: string, payload: Record<string, unknown> = {}): Promise<void> {
    const result = await database().from('audit_events').insert({ actor_id: actorId, action, entity_type: entityType, entity_id: entityId, payload_json: payload });
    if (result.error) throw new Error(result.error.message);
  }
}
