import { isTaskPathEditable, normalizeScopePath, type TaskScope } from '@techunter/core';
import { httpError } from './errors.js';

export function scopeIssueBody(body: string, scope: TaskScope): string {
  const section = [
    '### Files Involved',
    `Techunter 文件范围 · REV ${scope.revision}（以平台当前授权为准）`,
    ...scope.editablePaths.map((file) => `- MODIFY \`${file}\``),
    ...scope.readonlyPaths.filter((file) => !scope.editablePaths.includes(file)).map((file) => `- READ \`${file}\``),
  ].join('\n');
  return /^### Files Involved\r?$/m.test(body)
    ? body.replace(/^### Files Involved\r?\n(?:(?!^### )[\s\S])*/m, () => `${section}\n\n`)
    : `${body.trimEnd()}\n\n${section}\n`;
}

export function assertPullFilesInScope(files: Array<{ filename: string; previous_filename?: string }>, changedFileCount: number, scope: TaskScope): void {
  if (changedFileCount < 1 || changedFileCount > 3_000 || files.length !== changedFileCount) {
    throw httpError('无法完整校验 PR 文件范围，不能验收。', 409, 'PULL_SCOPE_INCOMPLETE');
  }
  for (const file of files) {
    for (const candidate of [file.filename, file.previous_filename].filter((value): value is string => Boolean(value))) {
      let normalized: string;
      try { normalized = normalizeScopePath(candidate); }
      catch { throw httpError('PR 包含非法文件路径。', 409, 'PULL_SCOPE_INVALID'); }
      if (normalized !== candidate || !isTaskPathEditable(normalized, scope)) throw httpError(`PR 包含未授权修改：${candidate}。请先完成范围复议并重新提交。`, 409, 'PULL_SCOPE_INVALID');
    }
  }
}
