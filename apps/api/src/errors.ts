export function httpError(message: string, statusCode: number, code?: string): Error {
  const error = new Error(message) as Error & { statusCode?: number; code?: string };
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

export function translateDatabaseError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const known: Record<string, [number, string]> = {
    TASK_ALREADY_CLAIMED: [409, '任务刚刚被其他成员认领。'],
    TASK_NOT_RELEASABLE: [409, '任务当前不能释放。'],
    OPEN_CHILD_TASKS: [409, '存在未完成子任务，不能释放父任务。'],
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
