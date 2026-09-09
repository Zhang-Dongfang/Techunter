import { validateScopeExpansion, type ScopeRequest, type ScopeRequestDecision, type ScopeRequestInput, type Task, type TaskScope, type User } from '@techunter/core';
import { z } from 'zod';
import { database, dataOrThrow, type TechunterDatabase } from './database.js';
import { httpError, translateDatabaseError } from './errors.js';

const explanation = z.string().trim().min(10).max(5_000);
export const scopeRequestBody = z.object({
  scopeRevision: z.number().int().positive(),
  files: z.array(z.object({ path: z.string().min(1).max(500), reason: z.string().trim().min(5).max(2_000) }).strict()).min(1).max(20),
  reason: explanation,
  evidence: explanation,
  alternatives: explanation,
  validationPlan: explanation,
  retryOf: z.string().uuid().optional(),
}).strict();
export const scopeDecisionBody = z.object({
  decision: z.enum(['approve', 'reject']),
  approvedPaths: z.array(z.string().min(1).max(500)).max(20),
  reason: z.string().trim().min(5).max(5_000),
}).strict();

type TaskReader = { getTask(id: string): Promise<Task> };

export function canReviewScope(task: Task, actor: User): boolean {
  return task.assignee?.id !== actor.id && (task.publisher.id === actor.id || actor.role === 'admin');
}

export function assertScopeRequester(task: Task, actor: User, revision: number): asserts task is Task & { scope: TaskScope } {
  if (task.assignee?.id !== actor.id) throw httpError('只有当前任务接取者可以申请扩大修改范围。', 403, 'FORBIDDEN');
  if (task.status !== 'active' || !task.scope) throw httpError('只有进行中的任务可以申请扩大修改范围。', 409, 'SCOPE_TASK_NOT_ACTIVE');
  if (task.scope.revision !== revision) throw httpError('文件范围已更新，请刷新任务后重新申请。', 409, 'SCOPE_REVISION_CONFLICT');
}

export function validateScopeDecision(task: Task, request: ScopeRequest, actor: User, input: ScopeRequestDecision, parent: Task | null): void {
  if (request.requesterId === actor.id || task.assignee?.id === actor.id) throw httpError('不能审批自己的范围申请。', 403, 'SCOPE_SELF_REVIEW');
  if (!canReviewScope(task, actor)) throw httpError('只有任务发布者或管理员可以审批范围申请。', 403, 'FORBIDDEN');
  if (request.status !== 'pending') throw httpError('申请已处理，请刷新记录。', 409, 'SCOPE_REQUEST_RESOLVED');
  if (task.status !== 'active' || task.assignee?.id !== request.requesterId || !task.scope) throw httpError('任务状态或执行者已变化。', 409, 'SCOPE_TASK_NOT_ACTIVE');
  if (task.scope.revision !== request.scopeRevision) throw httpError('申请基于旧文件范围，请重新申请。', 409, 'SCOPE_REVISION_CONFLICT');
  if (input.decision === 'reject') {
    if (input.approvedPaths.length) throw httpError('驳回申请时不能授权文件。', 400, 'SCOPE_DECISION_INVALID');
    return;
  }
  if (input.approvedPaths.some((file) => !request.files.some((requested) => requested.path === file))) {
    throw httpError('只能批准本次申请中的文件。', 400, 'SCOPE_DECISION_INVALID');
  }
  validateExpansion(task, input.approvedPaths, parent);
}

function validateExpansion(task: Task, paths: string[], parent: Task | null): string[] {
  if (!task.scope) throw httpError('任务缺少文件范围。', 409);
  if (task.parentTaskId && (!parent?.scope || !['active', 'submitted'].includes(parent.status))) {
    throw httpError('父任务缺少有效的文件范围，暂时不能扩大子任务权限。', 409, 'SCOPE_PARENT_UNAVAILABLE');
  }
  try { return validateScopeExpansion(task.scope, paths, parent?.scope); }
  catch (error) { throw httpError((error as Error).message, 400, 'SCOPE_PATH_INVALID'); }
}

function fromRow(row: Record<string, any>): ScopeRequest {
  return {
    id: row['id'], taskId: row['task_id'], requesterId: row['requester_id'], scopeRevision: row['scope_revision'],
    files: row['files_json'], reason: row['reason'], evidence: row['evidence'], alternatives: row['alternatives'],
    validationPlan: row['validation_plan'], retryOf: row['retry_of'] ?? undefined, status: row['status'],
    approvedPaths: row['approved_paths'], reviewerId: row['reviewer_id'], reviewReason: row['review_reason'],
    resultingRevision: row['resulting_revision'], createdAt: row['created_at'], resolvedAt: row['resolved_at'],
  };
}

export class ScopeRequestService {
  constructor(private readonly tasks: TaskReader, private readonly db: () => TechunterDatabase = database) {}

  async list(taskId: string, actor: User): Promise<ScopeRequest[]> {
    const task = await this.tasks.getTask(taskId);
    let query = this.db().from('scope_requests').select('*').eq('task_id', taskId);
    if (task.publisher.id !== actor.id && actor.role !== 'admin') query = query.eq('requester_id', actor.id);
    const rows = dataOrThrow(await query.order('created_at', { ascending: false }));
    return rows.map(fromRow);
  }

  private async get(taskId: string, id: string): Promise<ScopeRequest> {
    const result = await this.db().from('scope_requests').select('*').eq('task_id', taskId).eq('id', id).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw httpError('范围申请不存在。', 404, 'SCOPE_REQUEST_NOT_FOUND');
    return fromRow(result.data);
  }

  async create(taskId: string, actor: User, raw: ScopeRequestInput): Promise<ScopeRequest> {
    const input = scopeRequestBody.parse(raw);
    const task = await this.tasks.getTask(taskId);
    assertScopeRequester(task, actor, input.scopeRevision);
    const parent = task.parentTaskId ? await this.tasks.getTask(task.parentTaskId) : null;
    const paths = validateExpansion(task, input.files.map((file) => file.path), parent);
    if (input.retryOf) {
      const previous = await this.get(taskId, input.retryOf);
      if (previous.requesterId !== actor.id || !['rejected', 'partially_approved'].includes(previous.status)) {
        throw httpError('只能复议本人被驳回或部分批准的申请。', 400, 'SCOPE_RETRY_INVALID');
      }
      if (input.evidence === previous.evidence) throw httpError('再次复议需要补充新的证据，并回应此前审批意见。', 400, 'SCOPE_RETRY_INVALID');
    }
    const result = await this.db().rpc('create_scope_request', {
      p_task_id: taskId, p_actor_id: actor.id, p_scope: task.scope, p_parent_scope: parent?.scope ?? null,
      p_files: input.files.map((file, index) => ({ ...file, path: paths[index]! })),
      p_reason: input.reason, p_evidence: input.evidence, p_alternatives: input.alternatives,
      p_validation_plan: input.validationPlan, p_retry_of: input.retryOf ?? null,
    });
    if (result.error) translateDatabaseError(new Error(result.error.message));
    return this.get(taskId, String(result.data));
  }

  async decide(taskId: string, id: string, actor: User, raw: ScopeRequestDecision): Promise<ScopeRequest> {
    const input = scopeDecisionBody.parse(raw);
    const [task, request] = await Promise.all([this.tasks.getTask(taskId), this.get(taskId, id)]);
    const parent = task.parentTaskId ? await this.tasks.getTask(task.parentTaskId) : null;
    validateScopeDecision(task, request, actor, input, parent);
    const result = await this.db().rpc('decide_scope_request', {
      p_task_id: taskId, p_request_id: id, p_actor_id: actor.id,
      p_scope: task.scope, p_parent_scope: parent?.scope ?? null,
      p_decision: input.decision, p_approved_paths: input.approvedPaths, p_reason: input.reason,
    });
    if (result.error) translateDatabaseError(new Error(result.error.message));
    return this.get(taskId, id);
  }

  async withdraw(taskId: string, id: string, actor: User): Promise<ScopeRequest> {
    const result = await this.db().rpc('withdraw_scope_request', { p_task_id: taskId, p_request_id: id, p_actor_id: actor.id });
    if (result.error) translateDatabaseError(new Error(result.error.message));
    return this.get(taskId, id);
  }
}
