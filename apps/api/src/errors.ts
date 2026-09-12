export function httpError(message: string, statusCode: number, code?: string): Error {
  const error = new Error(message) as Error & { statusCode?: number; code?: string };
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

export function translateDatabaseError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const known: Record<string, [number, string]> = {
    TASK_VERSION_CONFLICT: [409, '任务已更新或正在发布，请刷新后重试；旧分析结果未写入。'],
    OPERATION_IN_PROGRESS: [409, '该任务的操作仍在处理，请稍后重试恢复操作。'],
    OPERATION_LEASE_LOST: [409, '操作已由另一请求接续，请刷新任务。'],
    OPERATION_NOT_FOUND: [404, '找不到待恢复的操作。'],
    INVALID_REWARD: [400, '任务奖励必须是 1 到 100000 的整数。'],
    TASK_NOT_SUBMITTABLE: [409, '任务状态或执行者已变化，请刷新后重新提交。'],
    WORKSPACE_NOT_READY: [409, '本机工作环境尚未准备完成。'],
    SUBMISSION_STATE_CONFLICT: [409, '提交状态已变化，请刷新任务后重试。'],
    SUBMISSION_NOT_APPROVED: [409, '提交尚未通过预审。'],
    TASK_NOT_SUBMITTED: [409, '任务当前不在待验收状态。'],
    REVIEW_ACTION_CONFLICT: [409, '该提交已有审核操作正在处理，请重试原来的操作。'],
    SCOPE_TASK_NOT_ACTIVE: [409, '任务状态或接取者已变化，请刷新任务。'],
    SCOPE_REVISION_CONFLICT: [409, '文件范围已更新，请刷新后基于最新范围重新申请。'],
    SCOPE_PARENT_UNAVAILABLE: [409, '父任务缺少有效范围，请先处理父任务权限。'],
    SCOPE_REQUEST_PENDING: [409, '该任务已有待审批申请，请先等待处理或撤回。'],
    SCOPE_REQUEST_NOT_FOUND: [404, '范围申请不存在。'],
    SCOPE_REQUEST_RESOLVED: [409, '范围申请已经处理，请刷新记录。'],
    SCOPE_RETRY_INVALID: [400, '复议来源无效或已有后续申请，请刷新记录。'],
    SCOPE_SELF_REVIEW: [403, '不能审批自己的范围申请。'],
    SCOPE_DECISION_INVALID: [400, '审批须说明原因，且只能批准本次申请中的文件。'],
    TASK_ALREADY_CLAIMED: [409, '任务刚刚被其他成员认领。'],
    TASK_NOT_RELEASABLE: [409, '任务当前不能释放。'],
    OPEN_CHILD_TASKS: [409, '存在未完成子任务，请先完成或取消子任务。'],
    INSUFFICIENT_POINTS: [400, '项目可用贡献点不足。'],
    PARENT_BUDGET_EXCEEDED: [400, '子任务预算超过父任务剩余预算。'],
    SELF_REVIEW_FORBIDDEN: [403, '执行者不能验收自己的任务。'],
    FORBIDDEN: [403, '当前账号没有执行此操作的权限。'],
    TASK_NOT_FOUND: [404, '任务不存在。'],
    TASK_ALREADY_SETTLED: [409, '已验收结算的任务不能删除。'],
    TASK_ALREADY_CANCELLED: [409, '任务已经被取消。'],
    TASK_NOT_REMOVABLE: [409, '任务当前不能删除或取消。'],
  };
  const match = Object.entries(known).find(([code]) => message.includes(code));
  if (match) throw httpError(match[1][1], match[1][0], match[0]);
  throw error;
}
