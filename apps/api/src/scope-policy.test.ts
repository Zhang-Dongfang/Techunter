import assert from 'node:assert/strict';
import test from 'node:test';
import { expandTaskScope, isTaskPathEditable, normalizeScopePath, validateScopeExpansion, type ScopeRequest, type Task, type TaskScope, type User } from '@techunter/core';
import { assertScopeRequester, scopeRequestBody, validateScopeDecision } from './scope-request-service.js';
import { assertPullFilesInScope, scopeIssueBody } from './github-scope.js';
import { normalizePackageFiles } from './task-service.js';

const scope: TaskScope = {
  revision: 1, editablePaths: ['src/feature.ts'], readonlyPaths: ['README.md', 'src/context/**'],
  deniedPaths: ['src/private/**'], visibleTests: ['tests/unit.ts'],
  environment: { setupCommands: [], testCommands: ['npm test'], networkAllowlist: [] },
};
const worker = { id: 'worker', role: 'member' } as User;
const publisher = { id: 'publisher', role: 'member' } as User;
const task = { id: 'task', publisher, assignee: worker, scope, status: 'active', parentTaskId: null } as Task;
const request = { taskId: task.id, requesterId: worker.id, scopeRevision: 1, status: 'pending', files: [{ path: 'README.md', reason: '更新公开使用说明' }] } as ScopeRequest;

test('scope appeals accept concrete readonly and new files and reject broad, ambiguous and denied paths', () => {
  assert.deepEqual(validateScopeExpansion(scope, ['./README.md', 'src\\new.ts']), ['README.md', 'src/new.ts']);
  for (const path of ['../outside.ts', 'src/..', '/absolute', 'C:\\repo\\file', 'src/*', 'src/', 'src/./file', 'src//file', '.git', '.git/config', '.GIT/config', '.env', 'src/.ENV.prod', 'src/key.pem', 'src/private/file.ts', 'src/secrets/token', 'file:stream', '!foo', 'src/file\n.ts']) {
    assert.throws(() => validateScopeExpansion(scope, [path]), Error, path);
  }
  assert.throws(() => validateScopeExpansion(scope, ['src/feature.ts']), /已经/);
  assert.throws(() => validateScopeExpansion(scope, ['README.md', 'readme.md']), /重复/);
  assert.throws(() => validateScopeExpansion(scope, []));
  assert.throws(() => validateScopeExpansion(scope, Array.from({ length: 21 }, (_, i) => `file${i}.ts`)));
  assert.throws(() => normalizeScopePath('src/.. /file'));
});

test('approved expansion changes only selected paths and revision; parent and denied rules remain authoritative', () => {
  const expanded = expandTaskScope(scope, ['README.md', 'src/context/a.ts']);
  assert.equal(expanded.revision, 2);
  assert.deepEqual(expanded.readonlyPaths, ['src/context/**']);
  assert.deepEqual(expanded.deniedPaths, scope.deniedPaths);
  assert.deepEqual(expanded.environment, scope.environment);
  assert.deepEqual(expanded.visibleTests, scope.visibleTests);
  assert.equal(scope.revision, 1);
  assert.equal(isTaskPathEditable('src/context/a.ts', expanded), true);
  assert.equal(isTaskPathEditable('src/context/b.ts', expanded), false);
  assert.throws(() => expandTaskScope(scope, ['README.md'], { ...scope, readonlyPaths: ['README.md'] }), /父任务/);
  assert.throws(() => expandTaskScope(scope, ['README.md'], { ...scope, editablePaths: ['**/*'], deniedPaths: ['README.md'] }), /父任务/);
  assert.deepEqual(validateScopeExpansion(scope, ['README.md'], { ...scope, editablePaths: ['README.md'] }), ['README.md']);
});

test('API authorization excludes self approval, unrelated maintainers, old revisions, and unrequested grants', () => {
  assert.doesNotThrow(() => assertScopeRequester(task, worker, 1));
  assert.throws(() => assertScopeRequester(task, publisher, 1));
  assert.throws(() => assertScopeRequester(task, worker, 2));
  assert.throws(() => assertScopeRequester({ ...task, status: 'submitted' }, worker, 1));
  const approval = { decision: 'approve' as const, approvedPaths: ['README.md'], reason: '需要更新公共说明' };
  assert.doesNotThrow(() => validateScopeDecision(task, request, publisher, approval, null));
  assert.throws(() => validateScopeDecision(task, request, { ...worker, role: 'admin' }, approval, null));
  assert.throws(() => validateScopeDecision(task, request, { id: 'other', role: 'maintainer' } as User, approval, null));
  assert.throws(() => validateScopeDecision(task, request, publisher, { ...approval, approvedPaths: ['src/new.ts'] }, null));
  assert.throws(() => validateScopeDecision(task, request, publisher, { ...approval, approvedPaths: [] }, null));
  assert.throws(() => validateScopeDecision(task, { ...request, scopeRevision: 2 }, publisher, approval, null));
  assert.throws(() => validateScopeDecision(task, { ...request, status: 'withdrawn' }, publisher, approval, null));
  assert.throws(() => scopeRequestBody.parse({ scopeRevision: 1, files: [{ path: 'README.md', reason: '因为需要' }], reason: '不够', evidence: '', alternatives: '', validationPlan: '' }));
});

test('submission and PR gates accept approved files but reject readonly, denied, truncated and rename-source changes', () => {
  const file = { path: 'README.md', content: '# documentation', encoding: 'utf-8' as const };
  assert.throws(() => normalizePackageFiles([file], scope), /editablePaths/);
  const expanded = expandTaskScope(scope, ['README.md']);
  assert.equal(normalizePackageFiles([file], expanded)[0]?.path, file.path);
  assert.throws(() => normalizePackageFiles([{ ...file, path: '.env' }], { ...expanded, editablePaths: ['**/*'], deniedPaths: [] }));
  assert.doesNotThrow(() => assertPullFilesInScope([{ filename: 'README.md' }], 1, expanded));
  assert.throws(() => assertPullFilesInScope([{ filename: 'README.md', previous_filename: 'src/private/hidden.ts' }], 1, expanded));
  assert.throws(() => assertPullFilesInScope([{ filename: ' README.md' }], 1, expanded));
  assert.throws(() => assertPullFilesInScope([{ filename: 'README.md' }], 2, expanded));
  assert.throws(() => assertPullFilesInScope([], 3_001, expanded));
});

test('GitHub scope mirroring preserves task prose, metadata, and later sections and is repeatable', () => {
  const body = '### Task Description\nKeep my edits\n\n### Files Involved\n- MODIFY `old.ts`\n\n### Acceptance Criteria\n- tests pass\n\n<!-- techunter-task-id:123 -->';
  const expanded = expandTaskScope(scope, ['README.md']);
  const updated = scopeIssueBody(body, expanded);
  assert.match(updated, /Keep my edits/);
  assert.match(updated, /REV 2/);
  assert.match(updated, /MODIFY `README.md`/);
  assert.doesNotMatch(updated, /old.ts/);
  assert.match(updated, /### Acceptance Criteria\n- tests pass\n\n<!-- techunter-task-id:123 -->/);
  assert.equal(scopeIssueBody(updated, expanded), updated);
});
