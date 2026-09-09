import { minimatch } from 'minimatch';
import { repositoryDefaultDeniedPatterns } from './repository-tools.js';
import type { TaskScope } from './types.js';

/** Scope appeals grant concrete files, never directory or glob permissions. */
export function normalizeScopePath(value: string): string {
  const file = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!file || file.length > 500 || /[\x00-\x1f\x7f:*?\[\]{}()!#`]/.test(file)
    || file.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new Error('请填写具体的仓库相对文件路径，不能使用目录、通配符或路径跳转。');
  }
  return file;
}

export function matchesScopePath(file: string, patterns: string[], nocase = false): boolean {
  return patterns.some((pattern) => minimatch(file, pattern, { dot: true, nonegate: true, nocomment: true, nocase }));
}

export function isDeniedScopePath(file: string, scope: TaskScope): boolean {
  return file.split('/').some((part) => part.toLowerCase() === '.git')
    || matchesScopePath(file, [...repositoryDefaultDeniedPatterns, ...scope.deniedPaths], true);
}

export function isTaskPathEditable(file: string, scope: TaskScope): boolean {
  return matchesScopePath(file, scope.editablePaths) && !isDeniedScopePath(file, scope);
}

export function validateScopeExpansion(scope: TaskScope, paths: string[], parentScope?: TaskScope | null): string[] {
  if (!paths.length || paths.length > 20) throw new Error('每次申请须包含 1–20 个具体文件。');
  const normalized = paths.map(normalizeScopePath);
  if (new Set(normalized.map((file) => file.toLowerCase())).size !== normalized.length) throw new Error('申请中不能包含重复文件。');
  for (const file of normalized) {
    if (isDeniedScopePath(file, scope)) throw new Error(`该路径不可申请修改权限：${file}`);
    if (matchesScopePath(file, scope.editablePaths)) throw new Error(`该文件已经可以修改：${file}`);
    if (parentScope && !isTaskPathEditable(file, parentScope)) {
      throw new Error('申请超出父任务可修改范围；请由父任务执行者先向上申请，再重新提交子任务申请。');
    }
  }
  return normalized;
}

export function expandTaskScope(scope: TaskScope, approvedPaths: string[], parentScope?: TaskScope | null): TaskScope {
  const paths = validateScopeExpansion(scope, approvedPaths, parentScope);
  return {
    ...scope,
    revision: scope.revision + 1,
    editablePaths: [...scope.editablePaths, ...paths],
    // Keep readonly globs: explicit editable grants take precedence for their concrete files.
    readonlyPaths: scope.readonlyPaths.filter((file) => !paths.includes(file)),
  };
}
