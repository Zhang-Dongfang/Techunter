import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  DashboardResponse,
  Project,
  Submission,
  Task,
  TaskAnalysis,
  TaskScope,
  TaskSummary,
  User,
  Workspace,
} from '../shared/contracts.js';
import { AgentService } from './agent-service.js';
import { Database } from './database.js';
import { GitHubService } from './github-service.js';
import { LedgerService } from './ledger.js';
import { WorkspaceService } from './workspace-service.js';

const execFileAsync = promisify(execFile);

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function publicUser(row: Record<string, unknown> | undefined): User | null {
  if (!row?.['user_id']) return null;
  return {
    id: String(row['user_id']),
    login: String(row['user_login']),
    name: String(row['user_name']),
    avatarUrl: row['user_avatar_url'] ? String(row['user_avatar_url']) : null,
    role: row['user_role'] as User['role'],
  };
}

export class TaskService {
  constructor(
    private readonly database: Database,
    private readonly ledger: LedgerService,
    private readonly agent: AgentService,
    private readonly github: GitHubService,
    private readonly workspaces: WorkspaceService,
  ) {}

  projects(): Project[] {
    const rows = this.database.raw.prepare('SELECT * FROM projects ORDER BY name').all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row['id']),
      name: String(row['name']),
      description: String(row['description']),
      repoOwner: String(row['repo_owner']),
      repoName: String(row['repo_name']),
      defaultBranch: String(row['default_branch']),
      localRepoPath: row['local_repo_path'] ? String(row['local_repo_path']) : null,
      availablePoints: this.ledger.balance('project', String(row['id'])),
    }));
  }

  dashboard(me: User): DashboardResponse {
    const reviewCount = (this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM submissions s
      JOIN tasks t ON t.id = s.task_id
      WHERE s.status = 'approved' AND t.assignee_id != ? AND t.status = 'submitted'
    `).get(me.id) as { count: number }).count;
    return {
      me,
      projects: this.projects(),
      tasks: this.listTasks(),
      myAvailablePoints: this.ledger.balance('user', me.id),
      reviewCount,
    };
  }

  listTasks(filters: { status?: string; assigneeId?: string; search?: string } = {}): TaskSummary[] {
    const clauses: string[] = [];
    const values: Array<string> = [];
    if (filters.status && filters.status !== 'all') {
      clauses.push('t.status = ?');
      values.push(filters.status);
    }
    if (filters.assigneeId) {
      clauses.push('t.assignee_id = ?');
      values.push(filters.assigneeId);
    }
    if (filters.search) {
      clauses.push('(t.title LIKE ? OR t.description LIKE ?)');
      values.push(`%${filters.search}%`, `%${filters.search}%`);
    }
    const rows = this.database.raw.prepare(`
      SELECT t.*, p.name AS project_name
      FROM tasks t JOIN projects p ON p.id = t.project_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY CASE t.status WHEN 'active' THEN 0 WHEN 'open' THEN 1 WHEN 'submitted' THEN 2 ELSE 3 END, t.updated_at DESC
    `).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.summaryFromRow(row));
  }

  getTask(id: string): Task {
    const row = this.database.raw.prepare(`
      SELECT t.*, p.name AS project_name
      FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!row) throw this.notFound('任务不存在。');

    const publisher = this.getUser(String(row['publisher_id']));
    const assignee = row['assignee_id'] ? this.getUser(String(row['assignee_id'])) : null;
    const reviewer = row['reviewer_id'] ? this.getUser(String(row['reviewer_id'])) : null;
    const workspaceRow = this.database.raw.prepare(
      'SELECT * FROM workspaces WHERE task_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(id) as Record<string, unknown> | undefined;
    const submissionRow = this.database.raw.prepare(
      'SELECT * FROM submissions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(id) as Record<string, unknown> | undefined;
    const childrenRows = this.database.raw.prepare(`
      SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.parent_task_id = ? ORDER BY t.created_at
    `).all(id) as Array<Record<string, unknown>>;

    return {
      id: String(row['id']),
      projectId: String(row['project_id']),
      projectName: String(row['project_name']),
      parentTaskId: row['parent_task_id'] ? String(row['parent_task_id']) : null,
      rootTaskId: row['root_task_id'] ? String(row['root_task_id']) : null,
      title: String(row['title']),
      description: String(row['description']),
      summary: String(row['summary']),
      acceptanceCriteria: parseJson<string[]>(row['acceptance_json'], []),
      status: row['status'] as Task['status'],
      rewardPoints: Number(row['reward_points']),
      publisher,
      assignee,
      reviewer,
      baseSha: String(row['base_sha']),
      targetBranch: String(row['target_branch']),
      githubIssueNumber: row['github_issue_number'] === null ? null : Number(row['github_issue_number']),
      githubIssueUrl: row['github_issue_url'] ? String(row['github_issue_url']) : null,
      scope: parseJson<TaskScope | null>(row['scope_json'], null),
      workspace: workspaceRow ? this.workspaceFromRow(workspaceRow) : null,
      latestSubmission: submissionRow ? this.submissionFromRow(submissionRow) : null,
      children: childrenRows.map((child) => this.summaryFromRow(child)),
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    };
  }

  async createDraft(input: {
    projectId: string;
    title: string;
    description: string;
    publisherId: string;
    parentTaskId?: string | null;
  }): Promise<Task> {
    const project = this.projectRow(input.projectId);
    let parent: Task | null = null;
    if (input.parentTaskId) {
      parent = this.getTask(input.parentTaskId);
      if (parent.projectId !== input.projectId) throw this.badRequest('子任务必须与父任务属于同一项目。');
      if (!['active', 'submitted'].includes(parent.status)) throw this.badRequest('只有进行中的任务可以创建子任务。');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const baseSha = await this.resolveHead(project.local_repo_path ? String(project.local_repo_path) : null);
    const targetBranch = parent ? `tch/task-${parent.id.slice(0, 8)}` : String(project.default_branch);
    this.database.raw.prepare(`
      INSERT INTO tasks (
        id, project_id, parent_task_id, root_task_id, title, description, status, publisher_id,
        base_sha, target_branch, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectId,
      parent?.id ?? null,
      parent ? (parent.rootTaskId ?? parent.id) : null,
      input.title.trim(),
      input.description.trim(),
      input.publisherId,
      baseSha,
      targetBranch,
      now,
      now,
    );
    this.database.audit(input.publisherId, 'task.created', 'task', id, { parentTaskId: parent?.id ?? null });
    return this.getTask(id);
  }

  async analyzeTask(taskId: string, actorId: string): Promise<TaskAnalysis> {
    const task = this.getTask(taskId);
    if (task.status !== 'draft') throw this.badRequest('只有草稿任务可以重新分析。');
    if (task.publisher.id !== actorId && this.getUser(actorId).role !== 'admin') throw this.forbidden();
    const project = this.projectRow(task.projectId);
    const parent = task.parentTaskId ? this.getTask(task.parentTaskId) : null;
    const analysis = await this.agent.analyze({
      title: task.title,
      description: task.description,
      repoPath: project.local_repo_path ? String(project.local_repo_path) : null,
      editableLimit: parent?.scope?.editablePaths,
      readonlyLimit: parent?.scope ? [...parent.scope.editablePaths, ...parent.scope.readonlyPaths] : undefined,
      inheritedDeniedPaths: parent?.scope?.deniedPaths,
    });
    this.database.raw.prepare(`
      UPDATE tasks SET summary = ?, acceptance_json = ?, scope_json = ?, reward_points = ?, updated_at = ?, lock_version = lock_version + 1
      WHERE id = ?
    `).run(
      analysis.summary,
      JSON.stringify(analysis.acceptanceCriteria),
      JSON.stringify(analysis.scope),
      analysis.suggestedPoints,
      new Date().toISOString(),
      taskId,
    );
    this.database.audit(actorId, 'task.analyzed', 'task', taskId, {
      suggestedPoints: analysis.suggestedPoints,
      confidence: analysis.confidence,
      scopeRevision: analysis.scope.revision,
    });
    return analysis;
  }

  async publishTask(taskId: string, actorId: string, rewardPoints?: number): Promise<Task> {
    let task = this.getTask(taskId);
    if (task.status !== 'draft') throw this.badRequest('只有草稿任务可以发布。');
    if (task.publisher.id !== actorId && this.getUser(actorId).role !== 'admin') throw this.forbidden();
    if (!task.scope || task.acceptanceCriteria.length === 0) throw this.badRequest('发布前必须完成 AI 分析并确认文件范围。');
    const reward = rewardPoints ?? task.rewardPoints;
    if (!Number.isInteger(reward) || reward <= 0) throw this.badRequest('任务贡献点必须是正整数。');

    const projectAvailable = this.ledger.account('project', task.projectId, 'available');
    const projectReserved = this.ledger.account('project', task.projectId, 'reserved');
    if (task.parentTaskId) {
      const parent = this.getTask(task.parentTaskId);
      const allocated = (this.database.raw.prepare(`
        SELECT COALESCE(SUM(reward_points), 0) AS total FROM tasks
        WHERE parent_task_id = ? AND id != ? AND status != 'cancelled'
      `).get(parent.id, task.id) as { total: number }).total;
      if (allocated + reward > parent.rewardPoints) {
        throw this.badRequest(`子任务预算超过父任务剩余预算，最多可分配 ${Math.max(0, parent.rewardPoints - allocated)} 点。`);
      }
      this.database.raw.prepare(
        "UPDATE tasks SET status = 'open', reward_points = ?, payer_account_id = ?, updated_at = ?, lock_version = lock_version + 1 WHERE id = ?"
      ).run(reward, parent.projectId, new Date().toISOString(), taskId);
    } else {
      this.database.transaction(() => {
        this.ledger.postInTransaction({
          idempotencyKey: `task:${taskId}:reserve`,
          type: 'task_reserve',
          amount: reward,
          fromAccountId: projectAvailable.id,
          toAccountId: projectReserved.id,
          taskId,
          memo: `发布任务：${task.title}`,
        });
        this.database.raw.prepare(
          "UPDATE tasks SET status = 'open', reward_points = ?, payer_account_id = ?, updated_at = ?, lock_version = lock_version + 1 WHERE id = ?"
        ).run(reward, task.projectId, new Date().toISOString(), taskId);
      });
    }
    this.database.audit(actorId, 'task.published', 'task', taskId, { rewardPoints: reward });
    task = this.getTask(taskId);

    const project = this.projectRow(task.projectId);
    try {
      const issue = await this.github.createIssue(task, { owner: String(project.repo_owner), name: String(project.repo_name) });
      if (issue) {
        this.database.raw.prepare('UPDATE tasks SET github_issue_number = ?, github_issue_url = ?, updated_at = ? WHERE id = ?')
          .run(issue.number, issue.url, new Date().toISOString(), task.id);
      }
    } catch (error) {
      this.database.audit(actorId, 'github.issue_failed', 'task', taskId, { error: (error as Error).message });
    }
    return this.getTask(taskId);
  }

  async claimTask(taskId: string, user: User): Promise<Task> {
    const task = this.getTask(taskId);
    if (task.status !== 'open') throw this.conflict('任务已被认领或不可认领。');
    const now = new Date();
    const claimId = randomUUID();
    this.database.transaction(() => {
      const result = this.database.raw.prepare(`
        UPDATE tasks SET status = 'active', assignee_id = ?, updated_at = ?, lock_version = lock_version + 1
        WHERE id = ? AND status = 'open' AND assignee_id IS NULL
      `).run(user.id, now.toISOString(), taskId);
      if (result.changes !== 1) throw this.conflict('任务刚刚被其他成员认领。');
      this.database.raw.prepare(
        'INSERT INTO claims (id, task_id, user_id, lease_expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(claimId, taskId, user.id, new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString(), now.toISOString());
      this.database.audit(user.id, 'task.claimed', 'task', taskId, { claimId });
    });
    const claimed = this.getTask(taskId);
    const project = this.projectRow(task.projectId);
    try {
      await this.github.syncClaim(claimed, { owner: String(project.repo_owner), name: String(project.repo_name) }, user.login);
    } catch (error) {
      this.database.audit(user.id, 'github.claim_sync_failed', 'task', taskId, { error: (error as Error).message });
    }
    return claimed;
  }

  releaseTask(taskId: string, user: User): Task {
    const task = this.getTask(taskId);
    if (task.status !== 'active' || task.assignee?.id !== user.id) throw this.badRequest('只能释放自己正在执行的任务。');
    const childCount = (this.database.raw.prepare(
      "SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id = ? AND status NOT IN ('accepted','cancelled')"
    ).get(taskId) as { count: number }).count;
    if (childCount > 0) throw this.badRequest('存在未完成子任务，不能释放父任务。');
    this.database.transaction(() => {
      this.database.raw.prepare(
        "UPDATE tasks SET status = 'open', assignee_id = NULL, updated_at = ?, lock_version = lock_version + 1 WHERE id = ?"
      ).run(new Date().toISOString(), taskId);
      this.database.raw.prepare('UPDATE claims SET released_at = ? WHERE task_id = ? AND released_at IS NULL')
        .run(new Date().toISOString(), taskId);
      this.database.audit(user.id, 'task.released', 'task', taskId);
    });
    return this.getTask(taskId);
  }

  async createWorkspace(taskId: string, user: User): Promise<Workspace> {
    const task = this.getTask(taskId);
    if (task.assignee?.id !== user.id && user.role !== 'admin') throw this.forbidden();
    if (task.status !== 'active') throw this.badRequest('只有进行中的任务可以创建工作环境。');
    if (!task.scope) throw this.badRequest('任务没有有效文件范围。');
    const running = this.database.raw.prepare(
      "SELECT * FROM workspaces WHERE task_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1"
    ).get(taskId) as Record<string, unknown> | undefined;
    if (running) return this.workspaceFromRow(running);
    const project = this.projectRow(task.projectId);
    if (!project.local_repo_path) throw this.badRequest('项目没有配置服务端仓库路径，无法生成工作包。');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.raw.prepare(`
      INSERT INTO workspaces (id, task_id, status, provider, created_at, updated_at)
      VALUES (?, ?, 'provisioning', 'package', ?, ?)
    `).run(id, taskId, now, now);
    try {
      const packagePath = await this.workspaces.createPackage(task, String(project.local_repo_path), task.scope);
      this.database.raw.prepare(
        "UPDATE workspaces SET status = 'running', package_path = ?, updated_at = ? WHERE id = ?"
      ).run(packagePath, new Date().toISOString(), id);
      this.database.audit(user.id, 'workspace.created', 'workspace', id, { taskId, packagePath, scopeRevision: task.scope.revision });
    } catch (error) {
      this.database.raw.prepare("UPDATE workspaces SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
        .run((error as Error).message, new Date().toISOString(), id);
      throw error;
    }
    return this.workspaceFromRow(this.database.raw.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Record<string, unknown>);
  }

  async submitTask(taskId: string, user: User, input: { summary: string; testOutput: string }): Promise<Submission> {
    const task = this.getTask(taskId);
    if (task.status !== 'active' || task.assignee?.id !== user.id) throw this.badRequest('只有任务执行者可以提交进行中的任务。');
    const openChildren = (this.database.raw.prepare(
      "SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id = ? AND status NOT IN ('accepted','cancelled')"
    ).get(taskId) as { count: number }).count;
    if (openChildren > 0) throw this.badRequest(`还有 ${openChildren} 个子任务未完成。`);
    const workspace = task.workspace;
    if (!workspace?.packagePath || workspace.status !== 'running') throw this.badRequest('没有可提交的运行中工作包。');
    const files = await this.workspaces.collectChanges(workspace.packagePath);
    if (files.length === 0) throw this.badRequest('editablePaths 范围内没有检测到任何改动。');

    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.raw.prepare(`
      INSERT INTO submissions (id, task_id, author_id, status, summary, test_output, files_json, created_at, updated_at)
      VALUES (?, ?, ?, 'reviewing', ?, ?, ?, ?, ?)
    `).run(id, taskId, user.id, input.summary.trim(), input.testOutput.trim(), JSON.stringify(files), now, now);
    this.database.raw.prepare("UPDATE tasks SET status = 'submitted', updated_at = ?, lock_version = lock_version + 1 WHERE id = ?")
      .run(now, taskId);
    this.database.audit(user.id, 'submission.created', 'submission', id, { taskId, changedFiles: files.map((file) => file.path) });

    const review = await this.agent.review({
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      changedFiles: files.map((file) => ({ path: file.path, content: file.content?.slice(0, 30_000) ?? null })),
      testOutput: input.testOutput,
      summary: input.summary,
    });
    const status = review.verdict === 'approved' ? 'approved' : 'changes_requested';
    this.database.raw.prepare('UPDATE submissions SET status = ?, review_json = ?, updated_at = ? WHERE id = ?')
      .run(status, JSON.stringify(review), new Date().toISOString(), id);
    if (review.verdict === 'changes_requested') {
      this.database.raw.prepare("UPDATE tasks SET status = 'active', updated_at = ?, lock_version = lock_version + 1 WHERE id = ?")
        .run(new Date().toISOString(), taskId);
    }
    const project = this.projectRow(task.projectId);
    try {
      const pullUrl = await this.github.publishSubmission(
        this.getTask(taskId),
        { owner: String(project.repo_owner), name: String(project.repo_name), defaultBranch: String(project.default_branch) },
        files,
        review,
      );
      if (pullUrl) this.database.raw.prepare('UPDATE submissions SET pull_request_url = ? WHERE id = ?').run(pullUrl, id);
    } catch (error) {
      this.database.audit(user.id, 'github.submission_failed', 'submission', id, { error: (error as Error).message });
    }
    this.database.audit(null, 'review.completed', 'submission', id, { score: review.score, verdict: review.verdict });
    return this.getSubmission(id);
  }

  async acceptSubmission(submissionId: string, reviewer: User): Promise<Task> {
    const submission = this.getSubmission(submissionId);
    if (submission.status !== 'approved') throw this.badRequest('只有通过预审的提交可以验收。');
    const task = this.getTask(submission.taskId);
    if (task.status !== 'submitted') throw this.badRequest('任务当前不在待验收状态。');
    if (task.assignee?.id === reviewer.id) throw this.forbidden('执行者不能验收自己的任务。');
    if (!task.assignee) throw this.badRequest('任务没有执行者。');
    const acceptedChildren = (this.database.raw.prepare(
      "SELECT COALESCE(SUM(reward_points), 0) AS total FROM tasks WHERE parent_task_id = ? AND status = 'accepted'"
    ).get(task.id) as { total: number }).total;
    const payout = task.parentTaskId ? task.rewardPoints : Math.max(0, task.rewardPoints - acceptedChildren);
    if (task.parentTaskId) {
      const parentWorkspace = this.database.raw.prepare(
        "SELECT package_path FROM workspaces WHERE task_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1"
      ).get(task.parentTaskId) as { package_path: string | null } | undefined;
      const submissionFiles = this.database.raw.prepare('SELECT files_json FROM submissions WHERE id = ?').get(submissionId) as
        { files_json: string };
      if (parentWorkspace?.package_path) {
        await this.workspaces.applyChanges(
          parentWorkspace.package_path,
          parseJson(submissionFiles.files_json, []),
        );
      }
    }
    this.database.transaction(() => {
      if (payout > 0) {
        const reserved = this.ledger.account('project', task.projectId, 'reserved');
        const recipient = this.ledger.account('user', task.assignee!.id, 'available');
        this.ledger.postInTransaction({
          idempotencyKey: `task:${task.id}:settle`,
          type: 'task_settlement',
          amount: payout,
          fromAccountId: reserved.id,
          toAccountId: recipient.id,
          taskId: task.id,
          memo: `任务验收：${task.title}`,
        });
      }
      this.database.raw.prepare(`
        UPDATE tasks SET status = 'accepted', reviewer_id = ?, updated_at = ?, lock_version = lock_version + 1 WHERE id = ?
      `).run(reviewer.id, new Date().toISOString(), task.id);
      this.database.audit(reviewer.id, 'task.accepted', 'task', task.id, { submissionId, payout });
    });
    const project = this.projectRow(task.projectId);
    try {
      await this.github.completeTask(task, { owner: String(project.repo_owner), name: String(project.repo_name) }, submission.pullRequestUrl);
    } catch (error) {
      this.database.audit(reviewer.id, 'github.complete_failed', 'task', task.id, { error: (error as Error).message });
    }
    return this.getTask(task.id);
  }

  requestChanges(submissionId: string, reviewer: User, reason: string): Task {
    const submission = this.getSubmission(submissionId);
    const task = this.getTask(submission.taskId);
    if (task.assignee?.id === reviewer.id) throw this.forbidden('执行者不能审核自己的任务。');
    this.database.transaction(() => {
      this.database.raw.prepare("UPDATE submissions SET status = 'changes_requested', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), submissionId);
      this.database.raw.prepare("UPDATE tasks SET status = 'active', updated_at = ?, lock_version = lock_version + 1 WHERE id = ?")
        .run(new Date().toISOString(), task.id);
      this.database.audit(reviewer.id, 'submission.changes_requested', 'submission', submissionId, { reason });
    });
    return this.getTask(task.id);
  }

  getSubmission(id: string): Submission {
    const row = this.database.raw.prepare('SELECT * FROM submissions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw this.notFound('提交不存在。');
    return this.submissionFromRow(row);
  }

  private summaryFromRow(row: Record<string, unknown>): TaskSummary {
    return {
      id: String(row['id']),
      projectId: String(row['project_id']),
      projectName: String(row['project_name']),
      parentTaskId: row['parent_task_id'] ? String(row['parent_task_id']) : null,
      title: String(row['title']),
      summary: String(row['summary'] || row['description']),
      status: row['status'] as TaskSummary['status'],
      rewardPoints: Number(row['reward_points']),
      publisher: this.getUser(String(row['publisher_id'])),
      assignee: row['assignee_id'] ? this.getUser(String(row['assignee_id'])) : null,
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    };
  }

  private workspaceFromRow(row: Record<string, unknown>): Workspace {
    return {
      id: String(row['id']),
      taskId: String(row['task_id']),
      status: row['status'] as Workspace['status'],
      provider: row['provider'] as Workspace['provider'],
      packagePath: row['package_path'] ? String(row['package_path']) : null,
      error: row['error'] ? String(row['error']) : null,
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    };
  }

  private submissionFromRow(row: Record<string, unknown>): Submission {
    return {
      id: String(row['id']),
      taskId: String(row['task_id']),
      author: this.getUser(String(row['author_id'])),
      status: row['status'] as Submission['status'],
      summary: String(row['summary']),
      testOutput: String(row['test_output']),
      pullRequestUrl: row['pull_request_url'] ? String(row['pull_request_url']) : null,
      review: parseJson(row['review_json'], null),
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    };
  }

  private getUser(id: string): User {
    const row = this.database.raw.prepare(`
      SELECT id AS user_id, login AS user_login, name AS user_name, avatar_url AS user_avatar_url, role AS user_role
      FROM users WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    const user = publicUser(row);
    if (!user) throw this.notFound('用户不存在。');
    return user;
  }

  private projectRow(id: string): Record<string, unknown> {
    const row = this.database.raw.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw this.notFound('项目不存在。');
    return row;
  }

  private async resolveHead(repoPath: string | null): Promise<string> {
    if (!repoPath) return '';
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, timeout: 5000 });
      return stdout.trim();
    } catch {
      return '';
    }
  }

  private error(message: string, statusCode: number): Error {
    const error = new Error(message) as Error & { statusCode?: number };
    error.statusCode = statusCode;
    return error;
  }

  private badRequest(message: string): Error { return this.error(message, 400); }
  private conflict(message: string): Error { return this.error(message, 409); }
  private notFound(message: string): Error { return this.error(message, 404); }
  private forbidden(message = '当前账号没有执行此操作的权限。'): Error { return this.error(message, 403); }
}
