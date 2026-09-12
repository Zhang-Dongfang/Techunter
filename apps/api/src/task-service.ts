import {
  isTaskPathEditable,
  normalizeScopePath,
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
import { database, dataOrThrow, type TechunterDatabase } from './database.js';
import { httpError, translateDatabaseError } from './errors.js';
import { GitHubService } from './github-service.js';
import { resolveTaskVersion } from './task-version.js';
import { runTaskOperation } from './task-operation.js';
import { readAllRows } from './database-pagination.js';

type Row = Record<string, any>;

function jsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value as T;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function normalizePackageFiles(files: PackageFile[], scope: TaskScope): PackageFile[] {
  const unique = new Set<string>();
  let totalBytes = 0;
  return files.map((file) => {
    let normalized: string;
    try { normalized = normalizeScopePath(file.path); }
    catch { throw httpError(`非法提交路径：${file.path}`, 400); }
    if (unique.has(normalized)) throw httpError(`提交包含重复路径：${normalized}`, 400);
    unique.add(normalized);
    if (!isTaskPathEditable(normalized, scope)) {
      throw httpError(`提交文件超出 editablePaths：${normalized}`, 400);
    }
    if (file.encoding !== 'utf-8' && file.encoding !== 'base64') throw httpError(`不支持的文件编码：${normalized}`, 400);
    if (file.mode !== undefined && file.mode !== '100644' && file.mode !== '100755') throw httpError(`不支持的 Git 文件模式：${normalized}`, 400);
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
    private readonly db: () => TechunterDatabase = database,
  ) {}

  async projects(): Promise<Project[]> {
    const rows = await readAllRows<Row>((from, to) => this.db().from('projects').select('*', { count: 'exact' }).order('name').order('id').range(from, to));
    return Promise.all(rows.map((row) => this.projectFromRow(row)));
  }

  async importProject(repository: GitHubRepositoryCandidate & { headSha: string }, actor: User): Promise<Project> {
    if (!repository.permissions.pull) throw httpError('当前 GitHub 账号没有读取该仓库的权限。', 403);
    const result = await this.db().rpc('import_project', {
      p_repository: repository, p_actor_id: actor.id, p_points: config().initialProjectPoints,
    });
    if (result.error) translateDatabaseError(new Error(result.error.message));
    return this.getProject(String(result.data));
  }

  async syncProject(projectId: string, actor: User, githubCredential: string): Promise<Project> {
    const current = await this.getProject(projectId);
    const repository = await this.github.repository(current.githubRepositoryId, githubCredential, current.sourceBranch);
    const update = await this.db().from('projects').update({
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
    }).eq('id', projectId).eq('source_branch', current.sourceBranch).eq('updated_at', current.updatedAt).select('*').maybeSingle();
    if (update.error) throw new Error(update.error.message);
    if (!update.data) return this.getProject(projectId);
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
    const update = await this.db().from('projects').update({
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
    }).eq('id', projectId).eq('updated_at', current.updatedAt).select('*').maybeSingle();
    if (update.error) throw new Error(update.error.message);
    if (!update.data) throw httpError('项目已被其他操作更新，请刷新后重新切换分支。', 409, 'PROJECT_VERSION_CONFLICT');
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
    const [projects, tasks, points, reviews] = await Promise.all([
      this.projects(),
      this.listTasks(),
      this.balance('user', me.id),
      this.db().rpc('review_queue_count', { p_user_id: me.id }),
    ]);
    if (reviews.error) throw new Error(reviews.error.message);
    return { me, projects, tasks, myAvailablePoints: points, reviewCount: Number(reviews.data) };
  }

  async listTasks(filters: { status?: string; assigneeId?: string; search?: string } = {}): Promise<TaskSummary[]> {
    const rows = await readAllRows<Row>((from, to) => {
      let query = this.db().from('tasks').select('*', { count: 'exact' }).order('updated_at', { ascending: false }).order('id', { ascending: false });
      if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status);
      else query = query.neq('status', 'cancelled');
      if (filters.assigneeId) query = query.eq('assignee_id', filters.assigneeId);
      if (filters.search) query = query.or(`title.ilike.%${filters.search.replaceAll(',', '')}%,description.ilike.%${filters.search.replaceAll(',', '')}%`);
      return query.range(from, to);
    });
    const summaries = await this.summariesFromRows(rows);
    const pending = await readAllRows<Row>((from, to) => this.db().from('scope_requests').select('task_id', { count: 'exact' }).eq('status', 'pending').order('id').range(from, to));
    const pendingIds = new Set(pending.map((row) => String(row['task_id'])));
    for (const task of summaries) task.pendingScopeRequestCount = pendingIds.has(task.id) ? 1 : 0;
    const order: Record<string, number> = { active: 0, open: 1, submitted: 2 };
    return summaries.sort((left, right) => (order[left.status] ?? 3) - (order[right.status] ?? 3) || right.updatedAt.localeCompare(left.updatedAt));
  }

  async getTask(id: string): Promise<Task> {
    const row = await this.taskRow(id);
    const [project, publisher, assignee, reviewer, workspaceResult, submissionResult, childrenResult, publicationResult] = await Promise.all([
      this.getProject(String(row['project_id'])),
      this.getUser(String(row['publisher_id'])),
      row['assignee_id'] ? this.getUser(String(row['assignee_id'])) : Promise.resolve(null),
      row['reviewer_id'] ? this.getUser(String(row['reviewer_id'])) : Promise.resolve(null),
      this.db().from('workspaces').select('*').eq('task_id', id).eq('user_id', row['assignee_id'] ?? '00000000-0000-0000-0000-000000000000').order('created_at', { ascending: false }).order('id', { ascending: false }),
      this.db().from('submissions').select('*').eq('task_id', id).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle(),
      this.db().from('tasks').select('*').eq('parent_task_id', id).order('created_at'),
      this.db().from('task_operations').select('id,kind,payload').eq('task_id', id).is('completed_at', null).maybeSingle(),
    ]);
    if (workspaceResult.error) throw new Error(workspaceResult.error.message);
    if (submissionResult.error) throw new Error(submissionResult.error.message);
    if (childrenResult.error) throw new Error(childrenResult.error.message);
    if (publicationResult.error) throw new Error(publicationResult.error.message);
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
      version: Number(row['lock_version']),
      pendingPublication: publicationResult.data?.kind === 'publish' ? { rewardPoints: Number(publicationResult.data.payload.reward) } : null,
      pendingOperation: publicationResult.data ? { id: String(publicationResult.data.id), kind: publicationResult.data.kind } : null,
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
      workingBranch: row['working_branch'] ? String(row['working_branch']) : null,
      githubIssueNumber: row['github_issue_number'] === null ? null : Number(row['github_issue_number']),
      githubIssueUrl: row['github_issue_url'] ? String(row['github_issue_url']) : null,
      analysis: effectiveAnalysis,
      scope,
      workspace: workspaceResult.data?.[0] ? this.workspaceFromRow(workspaceResult.data[0] as Row) : null,
      workspaces: (workspaceResult.data ?? []).map((workspace: Row) => this.workspaceFromRow(workspace)),
      latestSubmission: submissionResult.data ? await this.submissionFromRow(submissionResult.data as Row) : null,
      children: await this.summariesFromRows((childrenResult.data ?? []) as Row[]),
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
      if (parent.status !== 'active') throw httpError('只有进行中的任务可以创建子任务。', 400);
      const publisher = await this.getUser(input.publisherId);
      if (parent.assignee?.id !== input.publisherId && publisher.role !== 'admin') throw httpError('只有父任务执行者或管理员可以创建子任务。', 403);
      if (parent.githubIssueNumber === null || !parent.assignee?.githubLogin) throw httpError('母任务还没有可同步的远程任务分支。', 409);
    }
    const version = await resolveTaskVersion(project, parent, async (parentBranch) => {
      if (!parent?.assignee?.githubLogin) throw httpError('母任务还没有可同步的远程任务分支。', 409);
      const branch = await this.github.ensureTaskBranch(parent, project, parent.assignee.githubLogin, githubCredential);
      if (branch.name !== parentBranch) throw new Error('母任务分支解析不一致。');
      return branch.headSha;
    });
    const inserted = await this.db().from('tasks').insert({
      project_id: project.id,
      parent_task_id: parent?.id ?? null,
      root_task_id: parent ? (parent.rootTaskId ?? parent.id) : null,
      title: input.title.trim(),
      description: input.description.trim(),
      publisher_id: input.publisherId,
      base_sha: version.baseSha,
      target_branch: version.targetBranch,
    }).select('id').single();
    if (inserted.error) translateDatabaseError(new Error(inserted.error.message));
    const row = inserted.data as Row;
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
      project: { ...project, headSha: task.baseSha },
      githubCredential,
      editableLimit: parent?.scope?.editablePaths,
      readonlyLimit: parent?.scope ? [...parent.scope.editablePaths, ...parent.scope.readonlyPaths] : undefined,
      inheritedDeniedPaths: parent?.scope?.deniedPaths,
      modelCredential: authorization?.credential,
      modelAudience: authorization?.audience,
    });
    const update = await this.db().rpc('save_task_analysis', {
      p_task_id: taskId, p_actor_id: actor.id, p_version: task.version,
      p_parent_scope: parent?.scope ?? null, p_analysis: analysis,
    });
    if (update.error) translateDatabaseError(new Error(update.error.message));
    return analysis;
  }

  async publishTask(taskId: string, actor: User, rewardPoints: number | undefined, githubCredential?: string): Promise<Task> {
    const task = await this.getTask(taskId);
    if (task.publisher.id !== actor.id && actor.role !== 'admin') throw httpError('当前账号没有发布该任务的权限。', 403);
    if (task.githubIssueNumber && task.status !== 'draft') return task;
    if (task.status !== 'draft' || !task.scope) throw httpError('只有完成分析的草稿可以发布。', 400);
    const reward = task.pendingPublication?.rewardPoints ?? rewardPoints ?? task.analysis?.suggestedPoints ?? task.rewardPoints;
    const project = await this.getProject(task.projectId);
    const result = await this.db().rpc('begin_task_publication', {
      p_task_id: taskId, p_actor_id: actor.id, p_reward: reward, p_version: task.version,
    });
    if (result.error) translateDatabaseError(new Error(result.error.message));
    await runTaskOperation(this.db(), taskId, actor.id, async (payload, token, checkpoint) => {
      const issue = await this.github.createIssue({ ...task, rewardPoints: Number(payload['reward']) }, project, githubCredential, checkpoint);
      await checkpoint();
      const finished = await this.db().rpc('finish_task_publication', { p_id: taskId, p_token: token, p_issue_number: issue.number, p_issue_url: issue.url });
      if (finished.error) translateDatabaseError(new Error(finished.error.message));
    });
    return this.getTask(taskId);
  }

  async removeTask(taskId: string, actor: User, githubCredential?: string): Promise<{ id: string; disposition: 'deleted' | 'cancelled' }> {
    const task = await this.getTask(taskId);
    if (task.status === 'draft') {
      if (task.publisher.id !== actor.id && actor.role !== 'admin') throw httpError('只有草稿作者或管理员可以删除草稿。', 403);
      const result = await this.db().rpc('delete_task_draft', { p_task_id: taskId, p_actor_id: actor.id });
      if (result.error) translateDatabaseError(new Error(result.error.message));
      return { id: taskId, disposition: 'deleted' };
    }
    if (actor.role !== 'admin') throw httpError('只有管理员可以取消已发布的任务。', 403);
    const result = await this.db().rpc('begin_task_cancel', { p_task_id: taskId, p_actor_id: actor.id });
    if (result.error) translateDatabaseError(new Error(result.error.message));
    if (result.data) await runTaskOperation(this.db(), String(result.data), actor.id, async (_payload, token, checkpoint) => {
      const current = await this.getTask(taskId);
      await checkpoint();
      try {
        await this.github.cancelTask(current, await this.getProject(current.projectId), githubCredential, checkpoint);
      } catch (error) {
        if ((error as { code?: string }).code === 'PULL_ALREADY_MERGED') {
          const aborted = await this.db().rpc('abort_task_cancel', { p_id: result.data, p_token: token });
          if (aborted.error) translateDatabaseError(new Error(aborted.error.message));
        }
        throw error;
      }
      await checkpoint();
      const finished = await this.db().rpc('finish_task_cancel', { p_id: result.data, p_token: token });
      if (finished.error) translateDatabaseError(new Error(finished.error.message));
    });
    return { id: taskId, disposition: 'cancelled' };
  }

  async claimTask(taskId: string, user: User, githubCredential?: string): Promise<Task> {
    if (!user.githubLogin || !githubCredential) throw httpError('认领任务前请先连接 GitHub 账号。', 400);
    const current = await this.getTask(taskId);
    await this.github.assertClaimPermission(await this.getProject(current.projectId), githubCredential);
    const result = await this.db().rpc('begin_task_claim', { p_task_id: taskId, p_actor_id: user.id });
    if (result.error) translateDatabaseError(new Error(result.error.message));
    if (result.data) await runTaskOperation(this.db(), String(result.data), user.id, async (_payload, token, checkpoint) => {
      const task = await this.getTask(taskId);
      const project = await this.getProject(task.projectId);
      if (!task.assignee?.githubLogin) throw httpError('原执行者尚未连接 GitHub，请撤销认领后重新分配。', 409);
      await checkpoint();
      await this.github.syncClaim(task, project, task.assignee.githubLogin, githubCredential, checkpoint);
      await checkpoint();
      const finished = await this.db().rpc('finish_task_claim', { p_id: result.data, p_token: token });
      if (finished.error) translateDatabaseError(new Error(finished.error.message));
    });
    return this.getTask(taskId);
  }

  async releaseTask(taskId: string, user: User, githubCredential?: string): Promise<Task> {
    const task = await this.getTask(taskId);
    const adminRecovery = user.role === 'admin' && ['claim', 'release'].includes(task.pendingOperation?.kind ?? '');
    if (task.status !== 'active' || (task.assignee?.id !== user.id && !adminRecovery)) throw httpError('只能释放自己的任务，或由管理员恢复未完成的认领和释放。', 403);
    const result = await this.db().rpc('begin_task_release', { p_task_id: taskId, p_actor_id: user.id });
    if (result.error) translateDatabaseError(new Error(result.error.message));
    await runTaskOperation(this.db(), String(result.data), user.id, async (_payload, token, checkpoint) => {
      const project = await this.getProject(task.projectId);
      await checkpoint();
      await this.github.syncRelease(task, project, githubCredential, checkpoint);
      await checkpoint();
      const finished = await this.db().rpc('finish_task_release', { p_id: result.data, p_token: token });
      if (finished.error) translateDatabaseError(new Error(finished.error.message));
    });
    return this.getTask(taskId);
  }

  async createWorkspace(taskId: string, user: User, device: { deviceId: string; deviceLabel: string }): Promise<Workspace> {
    const task = await this.getTask(taskId);
    if (task.assignee?.id !== user.id) throw httpError('当前账号不能创建这个工作环境。', 403);
    if (task.status !== 'active' || !task.scope) throw httpError('只有进行中的有效任务可以创建工作环境。', 400);
    const result = await this.db().rpc('create_task_workspace', {
      p_task_id: taskId, p_user_id: user.id, p_device_id: device.deviceId, p_device_label: device.deviceLabel,
    });
    if (result.error) translateDatabaseError(new Error(result.error.message));
    const row = dataOrThrow(await this.db().from('workspaces').select('*').eq('id', result.data).single()) as Row;
    return this.workspaceFromRow(row);
  }

  async updateWorkspace(workspaceId: string, user: User, input: { status: 'provisioning' | 'running' | 'failed'; headSha?: string; setupLog?: string; error?: string | null }): Promise<Workspace> {
    const result = await this.db().rpc('update_task_workspace', { p_id: workspaceId, p_actor_id: user.id, p_update: input });
    if (result.error) translateDatabaseError(new Error(result.error.message));
    return this.workspaceFromRow(result.data as Row);
  }

  async submitTask(taskId: string, user: User, input: { workspaceId: string; summary: string; testOutput: string; files: PackageFile[]; headSha: string }, authorization?: { credential: string; audience: string }, githubCredential?: string): Promise<Submission> {
    const task = await this.getTask(taskId);
    if (task.status !== 'active' || task.assignee?.id !== user.id || !task.scope) throw httpError('只有任务执行者可以提交进行中的任务。', 400);
    const children = dataOrThrow(await this.db().from('tasks').select('id').eq('parent_task_id', taskId).not('status', 'in', '(accepted,cancelled)')) as Row[];
    if (children.length) throw httpError(`还有 ${children.length} 个子任务未完成。`, 400);
    const workspace = await this.db().from('workspaces').select('id').eq('id', input.workspaceId).eq('task_id', taskId).eq('user_id', user.id).eq('status', 'running').maybeSingle();
    if (workspace.error) throw new Error(workspace.error.message);
    if (!workspace.data) throw httpError('本机工作环境尚未准备完成。', 409, 'WORKSPACE_NOT_READY');
    const files = normalizePackageFiles(input.files, task.scope);
    if (!files.length) throw httpError('editablePaths 范围内没有检测到任何改动。', 400);
    const project = await this.getProject(task.projectId);
    await this.github.assertSubmissionHead(task, project, input.headSha, githubCredential);
    // Model failures must leave the task retryable. The database revalidates the
    // assignee, scope and lifecycle after this potentially long-running call.
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
    const begun = await this.db().rpc('begin_workspace_submission', {
      p_task_id: taskId, p_author_id: user.id, p_workspace_id: input.workspaceId, p_scope: task.scope,
      p_summary: input.summary.trim(), p_test_output: input.testOutput.trim(), p_files: files, p_review: review,
      p_head_sha: input.headSha,
    });
    if (begun.error) translateDatabaseError(new Error(begun.error.message));
    const submissionId = String(begun.data);
    await this.resumeSubmission(submissionId, user, githubCredential);
    await this.audit(user.id, 'submission.created', 'submission', submissionId, { taskId, changedFiles: files.map((file) => file.path) });
    return this.getSubmission(submissionId);
  }

  async cancelPublication(taskId: string, actor: User, githubCredential?: string): Promise<Task> {
    const task = await this.getTask(taskId);
    if (task.publisher.id !== actor.id && actor.role !== 'admin') throw httpError('当前账号不能撤回该发布。', 403);
    if (task.status !== 'draft' || !task.pendingPublication) throw httpError('任务没有待恢复的发布。', 409);
    await runTaskOperation(this.db(), taskId, actor.id, async (_payload, token, checkpoint) => {
      await this.github.cancelPublication(task, await this.getProject(task.projectId), githubCredential, checkpoint);
      await checkpoint();
      const result = await this.db().rpc('cancel_task_publication', { p_id: taskId, p_token: token });
      if (result.error) translateDatabaseError(new Error(result.error.message));
    });
    return this.getTask(taskId);
  }

  async resumeSubmission(submissionId: string, user: User, githubCredential?: string): Promise<Submission> {
    const submission = await this.getSubmission(submissionId);
    if (submission.author.id !== user.id && user.role !== 'admin') throw httpError('当前账号不能恢复这个提交。', 403);
    if (submission.status !== 'reviewing') return submission;
    const prepared = await this.db().rpc('prepare_submission_recovery', { p_id: submissionId, p_actor_id: user.id });
    if (prepared.error) translateDatabaseError(new Error(prepared.error.message));
    const task = await this.getTask(submission.taskId);
    const project = await this.getProject(task.projectId);
    await runTaskOperation(this.db(), submissionId, user.id, async (payload, token, checkpoint) => {
      const files = normalizePackageFiles(payload['files'], task.scope!);
      let pullUrl: string | null;
      try {
        if (!payload['review']) throw httpError('旧提交缺少预审证据，请重新交付。', 409, 'SUBMISSION_REVIEW_MISSING');
        pullUrl = await this.github.publishSubmission(task, project, files, payload['review'], githubCredential, {
          id: submissionId, headSha: payload['headSha'] ?? task.baseSha, checkpoint,
          recordTree: async (treeSha) => {
            await checkpoint();
            const saved = await this.db().rpc('record_submission_tree', { p_id: submissionId, p_token: token, p_tree_sha: treeSha });
            if (saved.error) translateDatabaseError(new Error(saved.error.message));
          },
          recordPull: async (url) => {
            await checkpoint();
            const saved = await this.db().rpc('record_submission_pull', { p_id: submissionId, p_token: token, p_pull_url: url });
            if (saved.error) translateDatabaseError(new Error(saved.error.message));
          },
        });
      } catch (error) {
        // These checks happen before any branch mutation. A changed remote head
        // needs a fresh workspace package, not retries of the stale snapshot.
        if (['WORKSPACE_BEHIND', 'SUBMISSION_REVIEW_MISSING'].includes((error as { code?: string }).code ?? '')) {
          await checkpoint();
          const saved = await this.getSubmission(submissionId);
          const restored = await this.db().rpc('finish_submission_operation', { p_id: submissionId, p_token: token, p_pull_url: saved.pullRequestUrl, p_succeeded: false });
          if (restored.error) translateDatabaseError(new Error(restored.error.message));
        }
        throw error;
      }
      await checkpoint();
      const finished = await this.db().rpc('finish_submission_operation', { p_id: submissionId, p_token: token, p_pull_url: pullUrl });
      if (finished.error) translateDatabaseError(new Error(finished.error.message));
    });
    return this.getSubmission(submissionId);
  }

  async acceptSubmission(submissionId: string, reviewer: User, githubCredential?: string): Promise<Task> {
    let submission = await this.getSubmission(submissionId);
    let task = await this.getTask(submission.taskId);
    const recoverMerged = task.status === 'active' && submission.status === 'changes_requested'
      && submission.review?.verdict === 'approved' && submission.author.id === task.assignee?.id;
    if ((!recoverMerged && (submission.status !== 'approved' || !['submitted', 'accepted'].includes(task.status))) || task.latestSubmission?.id !== submissionId) throw httpError('只有通过预审的最新待验收提交可以验收。', 409);
    if (task.assignee?.id === reviewer.id) throw httpError('执行者不能验收自己的任务。', 403);
    if (recoverMerged) {
      const project = await this.getProject(task.projectId);
      if (!submission.pullRequestUrl && submission.reviewedTreeSha) {
        submission = { ...submission, pullRequestUrl: await this.github.mergedSubmissionUrl(task, project, submission.reviewedTreeSha, githubCredential) };
      }
      await this.github.assertSubmissionMerged(task, project, submission.pullRequestUrl, githubCredential);
    }
    const result = recoverMerged
      ? await this.db().rpc('begin_merged_task_review_with_pull', { p_submission_id: submissionId, p_actor_id: reviewer.id, p_version: task.version, p_pull_url: submission.pullRequestUrl })
      : await this.db().rpc('begin_task_review', { p_submission_id: submissionId, p_actor_id: reviewer.id, p_action: 'accept' });
    if (result.error) translateDatabaseError(new Error(result.error.message));
    if (recoverMerged) { submission = await this.getSubmission(submissionId); task = await this.getTask(task.id); }
    if (result.data) await runTaskOperation(this.db(), String(result.data), reviewer.id, async (payload, token, checkpoint) => {
      let mergeAttempted = payload['phase'] !== 'ready';
      const mark = async (phase: 'merging' | 'merged') => {
        const saved = await this.db().rpc('mark_task_review', { p_id: result.data, p_token: token, p_phase: phase });
        if (saved.error) translateDatabaseError(new Error(saved.error.message));
      };
      try {
        const project = await this.getProject(task.projectId);
        let treeSha = submission.reviewedTreeSha;
        if (!treeSha) {
          // Rebuild legacy review evidence, never substitute the current PR tree.
          const row = dataOrThrow(await this.db().from('submissions').select('files_json').eq('id', submissionId).single()) as Row;
          const files = normalizePackageFiles(jsonValue<PackageFile[]>(row['files_json'], []), task.scope!);
          if (!files.length) throw httpError('该旧提交缺少可验证的审核快照，请要求重新交付。', 409);
          treeSha = await this.github.submissionTree(task, project, files.map(file => ({ ...file, mode: '100644' })), githubCredential);
        }
        await this.github.completeTask(task, project, submission.pullRequestUrl, githubCredential, {
          treeSha, checkpoint, mergedOnly: payload['mergedOnly'] === true,
          beforeMerge: async () => { await checkpoint(); await mark('merging'); mergeAttempted = true; },
          onMerged: async () => { mergeAttempted = true; await checkpoint(); await mark('merged'); },
        });
        mergeAttempted = true;
        await mark('merged');
        await checkpoint();
        const finished = await this.db().rpc('finish_task_review', { p_id: result.data, p_token: token });
        if (finished.error) translateDatabaseError(new Error(finished.error.message));
      } catch (error) {
        const definitelyUnmerged = (error as { code?: string }).code === 'GITHUB_MERGE_REJECTED';
        if (!mergeAttempted || definitelyUnmerged) {
          const aborted = await this.db().rpc('abort_task_review', { p_id: result.data, p_token: token, p_definitely_unmerged: definitelyUnmerged });
          if (aborted.error) translateDatabaseError(new Error(aborted.error.message));
        }
        throw error;
      }
    });
    return this.getTask(task.id);
  }

  async requestChanges(submissionId: string, reviewer: User, reason: string, githubCredential?: string): Promise<Task> {
    const submission = await this.getSubmission(submissionId);
    const task = await this.getTask(submission.taskId);
    if (task.assignee?.id === reviewer.id) throw httpError('执行者不能审核自己的任务。', 403);
    if (task.status !== 'submitted' || submission.status !== 'approved' || task.latestSubmission?.id !== submissionId) {
      throw httpError('只能对最新的待验收提交要求修改。', 409, 'SUBMISSION_STATE_CONFLICT');
    }
    const result = await this.db().rpc('begin_task_review', { p_submission_id: submissionId, p_actor_id: reviewer.id, p_action: 'request_changes', p_reason: reason });
    if (result.error) translateDatabaseError(new Error(result.error.message));
    await runTaskOperation(this.db(), String(result.data), reviewer.id, async (payload, token, checkpoint) => {
      await checkpoint();
      try {
        await this.github.syncChangesNeeded(task, await this.getProject(task.projectId), String(payload['reason']), githubCredential, { id: String(result.data), checkpoint });
      } catch (error) {
        if ((error as { code?: string }).code === 'PULL_ALREADY_MERGED') {
          await checkpoint();
          const aborted = await this.db().rpc('abort_task_changes', { p_id: result.data, p_token: token });
          if (aborted.error) translateDatabaseError(new Error(aborted.error.message));
        }
        throw error;
      }
      await checkpoint();
      const finished = await this.db().rpc('finish_task_review', { p_id: result.data, p_token: token });
      if (finished.error) translateDatabaseError(new Error(finished.error.message));
    });
    return this.getTask(task.id);
  }

  async getSubmission(id: string): Promise<Submission> {
    const row = dataOrThrow(await this.db().from('submissions').select('*').eq('id', id).single()) as Row;
    return this.submissionFromRow(row);
  }

  async points(userId: string): Promise<{ available: number; reserved: number; entries: LedgerEntry[] }> {
    const [available, reserved, accounts] = await Promise.all([
      this.balance('user', userId, 'available'),
      this.balance('user', userId, 'reserved'),
      this.db().from('point_accounts').select('id').eq('owner_type', 'user').eq('owner_id', userId),
    ]);
    if (accounts.error) throw new Error(accounts.error.message);
    const ids = (accounts.data ?? []).map((row: Row) => row['id']);
    if (!ids.length) return { available, reserved, entries: [] };
    const transfers = dataOrThrow(await this.db().from('point_transfers').select('*').or(`from_account_id.in.(${ids.join(',')}),to_account_id.in.(${ids.join(',')})`).order('created_at', { ascending: false }).limit(100)) as Row[];
    const entries = await Promise.all(transfers.map(async (row) => {
      const [source, destination] = await Promise.all([
        this.db().from('point_accounts').select('label').eq('id', row['from_account_id']).single(),
        this.db().from('point_accounts').select('label').eq('id', row['to_account_id']).single(),
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
    return dataOrThrow(await this.db().from('audit_events').select('*').order('created_at', { ascending: false }).limit(200)) as Row[];
  }

  private async taskRow(id: string): Promise<Row> {
    const result = await this.db().from('tasks').select('*').eq('id', id).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw httpError('任务不存在。', 404);
    return result.data as Row;
  }

  async getProject(id: string): Promise<Project> {
    const result = await this.db().from('projects').select('*').eq('id', id).maybeSingle();
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
    const result = await this.db().from('users').select('*').eq('id', id).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw httpError('用户不存在。', 404);
    return this.userFromRow(result.data as Row);
  }

  private userFromRow(row: Row): User {
    return {
      id: String(row['id']), login: String(row['login']), name: String(row['name']),
      avatarUrl: row['avatar_url'] ? String(row['avatar_url']) : null,
      email: row['email'] ? String(row['email']) : null,
      githubLogin: row['github_login'] ? String(row['github_login']) : null,
      role: row['role'] as User['role'],
    };
  }

  private async summariesFromRows(rows: Row[]): Promise<TaskSummary[]> {
    if (!rows.length) return [];
    const userIds = [...new Set(rows.flatMap(row => [row['publisher_id'], row['assignee_id']]).filter(Boolean))];
    const projectIds = [...new Set(rows.map(row => row['project_id']))];
    const [projectRows, userRows] = await Promise.all([
      this.rowsByIds('projects', 'id,name', projectIds),
      this.rowsByIds('users', '*', userIds),
    ]);
    const projects = new Map(projectRows.map(row => [String(row['id']), String(row['name'])]));
    const users = new Map(userRows.map(row => [String(row['id']), this.userFromRow(row)]));
    return rows.map(row => {
      const publisher = users.get(String(row['publisher_id']));
      const projectName = projects.get(String(row['project_id']));
      if (!publisher || projectName === undefined) throw new Error('任务关联的项目或用户不存在。');
      return {
        id: String(row['id']), projectId: String(row['project_id']), projectName,
        parentTaskId: row['parent_task_id'] ? String(row['parent_task_id']) : null,
        title: String(row['title']), summary: String(row['summary'] || row['description']),
        status: row['status'] as TaskSummary['status'], rewardPoints: Number(row['reward_points']),
        publisher, assignee: users.get(String(row['assignee_id'])) ?? null, createdAt: String(row['created_at']), updatedAt: String(row['updated_at']),
      };
    });
  }

  private async rowsByIds(table: string, columns: string, ids: string[]): Promise<Row[]> {
    const batches: Array<PromiseLike<Row[]>> = [];
    for (let start = 0; start < ids.length; start += 100) {
      batches.push(this.db().from(table).select(columns).in('id', ids.slice(start, start + 100)).then(result => dataOrThrow(result) as Row[]));
    }
    return (await Promise.all(batches)).flat();
  }

  private workspaceFromRow(row: Row): Workspace {
    return {
      id: String(row['id']), taskId: String(row['task_id']), userId: String(row['user_id']), status: row['status'] as Workspace['status'],
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
      reviewedTreeSha: row['reviewed_tree_sha'] ? String(row['reviewed_tree_sha']) : null,
      review: jsonValue(row['review_json'], null), createdAt: String(row['created_at']), updatedAt: String(row['updated_at']),
    };
  }

  private async balance(ownerType: 'project' | 'user', ownerId: string, bucket: 'available' | 'reserved' = 'available'): Promise<number> {
    const result = await this.db().from('point_accounts').select('balance').eq('owner_type', ownerType).eq('owner_id', ownerId).eq('bucket', bucket).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return Number(result.data?.balance ?? 0);
  }

  private async audit(actorId: string | null, action: string, entityType: string, entityId: string, payload: Record<string, unknown> = {}): Promise<void> {
    const result = await this.db().from('audit_events').insert({ actor_id: actorId, action, entity_type: entityType, entity_id: entityId, payload_json: payload });
    if (result.error) throw new Error(result.error.message);
  }
}
