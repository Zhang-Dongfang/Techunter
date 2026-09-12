import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { x as extractTar } from 'tar';
import {
  makeTaskBranchName,
  renderTaskGuide,
  taskLabelDefinitions,
  taskLabels,
  withTaskMetadata,
  type GitHubBranch,
  type GitHubRepositoryCandidate,
  type PackageFile,
  type Project,
  type Task,
  type DeliveryReview,
} from '@techunter/core';
import { config } from './config.js';
import { httpError } from './errors.js';
import { assertPullFilesInScope, scopeIssueBody } from './github-scope.js';

function visibility(value: unknown, privateRepository: boolean): GitHubRepositoryCandidate['visibility'] {
  if (value === 'internal') return 'internal';
  return privateRepository ? 'private' : 'public';
}

export class GitHubService {
  get configured(): boolean {
    const value = config().github;
    return Boolean(value.clientId || (value.appId && value.installationId && value.privateKey));
  }

  private async installationClient(checkoutRepositoryId?: number): Promise<{ octokit: Octokit; token: string; expiresAt: string }> {
    const value = config().github;
    if (value.appId && value.installationId && value.privateKey) {
      const auth = createAppAuth({
        appId: value.appId,
        installationId: Number(value.installationId),
        privateKey: value.privateKey,
      });
      const installation = await auth({ type: 'installation', ...(checkoutRepositoryId ? {
        repositoryIds: [checkoutRepositoryId], permissions: { contents: 'read' as const },
      } : {}) });
      return { octokit: new Octokit({ auth: installation.token, request: { timeout: 30_000 } }), token: installation.token, expiresAt: installation.expiresAt };
    }
    throw httpError('没有可用于该 GitHub 仓库的授权。', 503, 'GITHUB_NOT_CONFIGURED');
  }

  private async client(userCredential?: string): Promise<Octokit> {
    if (userCredential) return new Octokit({ auth: userCredential, request: { timeout: 30_000 } });
    return (await this.installationClient()).octokit;
  }

  async checkoutAuthorization(project: Project, userCredential: string): Promise<{ token: string; expiresAt: string | null }> {
    try {
      await this.repository(project.githubRepositoryId, userCredential, project.sourceBranch);
    } catch (error) {
      if ((error as { status?: number }).status === 404 && project.visibility !== 'public') {
        throw httpError('当前 GitHub 账号还不是该私有仓库的合作者。', 403, 'GITHUB_COLLABORATOR_REQUIRED');
      }
      throw error;
    }
    const value = config().github;
    if (value.appId && value.installationId && value.privateKey) {
      try {
        const installation = await this.installationClient(project.githubRepositoryId);
        await installation.octokit.repos.get({ owner: project.repoOwner, repo: project.repoName });
        return { token: installation.token, expiresAt: installation.expiresAt };
      } catch {
        // The repository may have been imported through user OAuth but not installed in the shared GitHub App.
      }
    }
    return { token: userCredential, expiresAt: null };
  }

  async requestCollaboration(project: Project, githubLogin: string, userCredential: string): Promise<{ status: 'invited' | 'already_collaborator'; actionUrl: string }> {
    try {
      await this.repository(project.githubRepositoryId, userCredential);
      return { status: 'already_collaborator', actionUrl: project.htmlUrl };
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }

    let installation: Awaited<ReturnType<GitHubService['installationClient']>>;
    try {
      installation = await this.installationClient();
    } catch {
      throw httpError('仓库管理员尚未配置可发送合作者邀请的 GitHub App。', 503, 'GITHUB_COLLABORATION_UNAVAILABLE');
    }

    try {
      const repository = await installation.octokit.repos.get({ owner: project.repoOwner, repo: project.repoName });
      const response = await installation.octokit.repos.addCollaborator({
        owner: project.repoOwner,
        repo: project.repoName,
        username: githubLogin,
        ...(repository.data.owner.type === 'Organization' ? { permission: 'push' as const } : {}),
      });
      const invitation = response as unknown as { status: number; data?: { html_url?: string } };
      return {
        status: invitation.status === 204 ? 'already_collaborator' : 'invited',
        actionUrl: invitation.data?.html_url || project.htmlUrl,
      };
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 403) {
        throw httpError('GitHub App 缺少该仓库的 Administration（write）权限，无法发送合作者邀请。', 503, 'GITHUB_COLLABORATION_UNAVAILABLE');
      }
      if (status === 404) {
        throw httpError('GitHub App 未安装到该私有仓库，暂时无法处理合作者申请。', 503, 'GITHUB_COLLABORATION_UNAVAILABLE');
      }
      if (status === 422) {
        throw httpError('GitHub 未能创建合作者邀请，可能受到组织策略或邀请频率限制。', 409, 'GITHUB_COLLABORATION_REJECTED');
      }
      throw error;
    }
  }

  async listRepositories(userCredential: string, importedIds: Set<number>): Promise<GitHubRepositoryCandidate[]> {
    const octokit = await this.client(userCredential);
    const repositories = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
      affiliation: 'owner,collaborator,organization_member',
      visibility: 'all',
      sort: 'updated',
      per_page: 100,
    });
    return repositories.map((repo) => ({
      githubRepositoryId: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      description: repo.description ?? '',
      owner: repo.owner.login,
      cloneUrl: repo.clone_url,
      htmlUrl: repo.html_url,
      defaultBranch: repo.default_branch,
      visibility: visibility(repo.visibility, repo.private),
      permissions: {
        admin: Boolean(repo.permissions?.admin),
        maintain: Boolean(repo.permissions?.maintain),
        push: Boolean(repo.permissions?.push),
        pull: repo.permissions?.pull !== false,
      },
      imported: importedIds.has(repo.id),
    }));
  }

  async repository(repositoryId: number, userCredential: string, sourceBranch?: string): Promise<GitHubRepositoryCandidate & { headSha: string }> {
    const octokit = await this.client(userCredential);
    const response = await octokit.request('GET /repositories/{repository_id}', { repository_id: repositoryId });
    const repo = response.data;
    const branch = sourceBranch?.trim() || repo.default_branch;
    let head;
    try {
      head = await octokit.git.getRef({ owner: repo.owner.login, repo: repo.name, ref: `heads/${branch}` });
    } catch (error) {
      if ((error as { status?: number }).status === 404) throw httpError(`GitHub 分支不存在：${branch}`, 404, 'GITHUB_BRANCH_NOT_FOUND');
      throw error;
    }
    return {
      githubRepositoryId: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      description: repo.description ?? '',
      owner: repo.owner.login,
      cloneUrl: repo.clone_url,
      htmlUrl: repo.html_url,
      defaultBranch: repo.default_branch,
      visibility: visibility(repo.visibility, repo.private),
      permissions: {
        admin: Boolean(repo.permissions?.admin),
        maintain: Boolean(repo.permissions?.maintain),
        push: Boolean(repo.permissions?.push),
        pull: repo.permissions?.pull !== false,
      },
      imported: false,
      headSha: head.data.object.sha,
    };
  }

  async listBranches(repositoryId: number, userCredential: string): Promise<GitHubBranch[]> {
    const octokit = await this.client(userCredential);
    const response = await octokit.request('GET /repositories/{repository_id}', { repository_id: repositoryId });
    const repo = response.data;
    const branches = await octokit.paginate(octokit.repos.listBranches, {
      owner: repo.owner.login,
      repo: repo.name,
      per_page: 100,
    });
    return branches.map((branch) => ({
      name: branch.name,
      sha: branch.commit.sha,
      protected: branch.protected,
      isDefault: branch.name === repo.default_branch,
    })).sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name));
  }

  async materialize(project: Project, userCredential?: string): Promise<{ root: string; cleanup(): Promise<void> }> {
    if (!userCredential) throw httpError('读取仓库前请先连接有访问权限的 GitHub 账号。', 401, 'GITHUB_ACCOUNT_REQUIRED');
    const octokit = await this.client(userCredential);
    // The shared project catalog does not grant access to its private source.
    await octokit.request('GET /repositories/{repository_id}', { repository_id: project.githubRepositoryId });
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'techunter-repo-'));
    const archive = path.join(tempRoot, 'repository.tar.gz');
    const root = path.join(tempRoot, 'repo');
    await fs.mkdir(root);
    try {
      const response = await octokit.request('GET /repos/{owner}/{repo}/tarball/{ref}', {
        owner: project.repoOwner,
        repo: project.repoName,
        ref: project.headSha || project.sourceBranch || project.defaultBranch,
      });
      const payload = response.data instanceof ArrayBuffer
        ? Buffer.from(response.data)
        : Buffer.from(response.data as unknown as Uint8Array);
      await fs.writeFile(archive, payload);
      await extractTar({ file: archive, cwd: root, strip: 1 });
      return { root, cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }) };
    } catch (error) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async createIssue(task: Task, project: Project, userCredential?: string, checkpoint: () => Promise<void> = async () => {}): Promise<{ number: number; url: string }> {
    const octokit = await this.client(userCredential);
    const location = { owner: project.repoOwner, repo: project.repoName };
    const marker = `<!-- techunter-task-id:${task.id} -->`;
    const findIssues = async () => (await octokit.paginate(octokit.issues.listForRepo, { ...location, state: 'all', per_page: 100 }))
      .filter(issue => !issue.pull_request && issue.body?.includes(marker)).sort((a, b) => a.number - b.number);
    const reconcile = async () => {
      const issues = await findIssues();
      const canonical = issues[0];
      if (canonical?.state === 'closed') {
        await checkpoint();
        await octokit.issues.update({ ...location, issue_number: canonical.number, state: 'open', labels: [taskLabels.available] });
      }
      for (const duplicate of issues.slice(1)) {
        await checkpoint();
        if (duplicate.state !== 'closed') await octokit.issues.update({ ...location, issue_number: duplicate.number, state: 'closed', state_reason: 'not_planned', labels: [] });
      }
      return canonical ? { number: canonical.number, url: canonical.html_url } : null;
    };
    const existing = await reconcile();
    await this.ensureLabels(octokit, project.repoOwner, project.repoName);
    if (!task.scope) throw httpError('任务缺少 Agent 生成的文件范围。', 400);
    const guide = task.analysis
      ? renderTaskGuide({ ...task.analysis, suggestedPoints: task.rewardPoints })
      : renderTaskGuide({
        summary: task.summary || task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        scope: task.scope,
        suggestedPoints: task.rewardPoints,
        confidence: 'low',
        rationale: task.description,
      });
    const body = withTaskMetadata({ body: guide, baseCommit: task.baseSha, targetBranch: task.targetBranch, taskId: task.id });
    await checkpoint();
    if (existing) {
      await octokit.issues.update({ ...location, issue_number: existing.number, title: task.title, body, state: 'open', labels: [taskLabels.available] });
      return existing;
    }
    const { data } = await octokit.issues.create({
      owner: project.repoOwner,
      repo: project.repoName,
      title: task.title,
      body,
      labels: [taskLabels.available],
    });
    return await reconcile() ?? { number: data.number, url: data.html_url };
  }

  async cancelPublication(task: Task, project: Project, userCredential: string | undefined, checkpoint: () => Promise<void>): Promise<void> {
    const octokit = await this.client(userCredential);
    const location = { owner: project.repoOwner, repo: project.repoName };
    const issues = await octokit.paginate(octokit.issues.listForRepo, { ...location, state: 'all', per_page: 100 });
    for (const issue of issues.filter(issue => !issue.pull_request && issue.body?.includes(`<!-- techunter-task-id:${task.id} -->`))) {
      await checkpoint();
      await octokit.issues.update({ ...location, issue_number: issue.number, state: 'closed', state_reason: 'not_planned', labels: [] });
    }
  }

  async ensureTaskBranch(task: Task, project: Project, githubLogin: string, userCredential?: string): Promise<{ name: string; headSha: string; created: boolean }> {
    if (!task.githubIssueNumber) throw httpError('任务还没有对应的 GitHub Issue。', 409);
    const octokit = await this.client(userCredential);
    const name = makeTaskBranchName(task.githubIssueNumber, githubLogin);
    try {
      const existing = await octokit.git.getRef({ owner: project.repoOwner, repo: project.repoName, ref: `heads/${name}` });
      return { name, headSha: existing.data.object.sha, created: false };
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
    const created = await octokit.git.createRef({
      owner: project.repoOwner,
      repo: project.repoName,
      ref: `refs/heads/${name}`,
      sha: task.baseSha,
    });
    return { name, headSha: created.data.object.sha, created: true };
  }

  async syncTaskScope(task: Task, project: Project, userCredential?: string): Promise<void> {
    if (!task.githubIssueNumber || !task.scope) throw httpError('任务缺少 GitHub Issue 或文件范围。', 409);
    const octokit = await this.client(userCredential);
    const location = { owner: project.repoOwner, repo: project.repoName, issue_number: task.githubIssueNumber };
    const issue = await octokit.issues.get(location);
    await octokit.issues.update({ ...location, body: scopeIssueBody(issue.data.body ?? '', task.scope) });
  }

  async syncClaim(task: Task, project: Project, githubLogin: string, userCredential?: string): Promise<void> {
    if (!task.githubIssueNumber) return;
    const octokit = await this.client(userCredential);
    const branch = await this.ensureTaskBranch(task, project, githubLogin, userCredential);
    try {
      await octokit.issues.update({ owner: project.repoOwner, repo: project.repoName, issue_number: task.githubIssueNumber, assignees: [githubLogin], labels: [taskLabels.claimed] });
    } catch (error) {
      if (branch.created) {
        await octokit.git.deleteRef({ owner: project.repoOwner, repo: project.repoName, ref: `heads/${branch.name}` }).catch(() => undefined);
      }
      throw error;
    }
  }

  async syncRelease(task: Task, project: Project, userCredential?: string): Promise<void> {
    if (!task.githubIssueNumber) return;
    const octokit = await this.client(userCredential);
    await octokit.issues.update({ owner: project.repoOwner, repo: project.repoName, issue_number: task.githubIssueNumber, assignees: [], labels: [taskLabels.available] });
  }

  async syncChangesNeeded(task: Task, project: Project, reason: string, userCredential?: string): Promise<void> {
    if (!task.githubIssueNumber) return;
    const octokit = await this.client(userCredential);
    await octokit.issues.update({ owner: project.repoOwner, repo: project.repoName, issue_number: task.githubIssueNumber, labels: [taskLabels.changesNeeded] });
    await octokit.issues.createComment({ owner: project.repoOwner, repo: project.repoName, issue_number: task.githubIssueNumber, body: `## 验收修改意见\n\n${reason}` });
  }

  private taskBranch(task: Task): string {
    return task.githubIssueNumber && task.assignee?.githubLogin
      ? makeTaskBranchName(task.githubIssueNumber, task.assignee.githubLogin) : `task-${task.id.slice(0, 8)}`;
  }

  async assertSubmissionHead(task: Task, project: Project, headSha: string, userCredential?: string): Promise<void> {
    const octokit = await this.client(userCredential);
    let current = task.baseSha;
    try { current = (await octokit.git.getRef({ owner: project.repoOwner, repo: project.repoName, ref: `heads/${this.taskBranch(task)}` })).data.object.sha; }
    catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
    if (!headSha || headSha !== current) throw httpError('远程任务分支已有新成果，请先同步工作环境、处理冲突后重新提交。', 409, 'WORKSPACE_BEHIND');
  }

  async submissionTree(task: Task, project: Project, files: PackageFile[], userCredential?: string): Promise<string> {
    return this.createSubmissionTree(await this.client(userCredential), task, project, files);
  }

  private async createSubmissionTree(octokit: Octokit, task: Task, project: Project, files: PackageFile[]): Promise<string> {
    const location = { owner: project.repoOwner, repo: project.repoName };
    const baseCommit = await octokit.git.getCommit({ ...location, commit_sha: task.baseSha });
    const modes = new Map<string, string>();
    if (files.some(file => file.content !== null && file.mode === undefined)) {
      const baseTree = await octokit.git.getTree({ ...location, tree_sha: baseCommit.data.tree.sha, recursive: 'true' });
      if (baseTree.data.truncated) throw httpError('仓库目录树不完整，请更新客户端以提交明确的文件模式。', 409);
      for (const entry of baseTree.data.tree) if (entry.path && entry.mode) modes.set(entry.path, entry.mode);
    }
    const tree = await Promise.all(files.map(async file => {
      if (file.content === null) return { path: file.path, mode: '100644' as const, type: 'blob' as const, sha: null };
      const mode = file.mode ?? modes.get(file.path) ?? '100644';
      if (mode !== '100644' && mode !== '100755') throw httpError('不支持提交该 Git 文件类型：' + file.path, 400);
      const blob = await octokit.git.createBlob({ ...location, content: file.content, encoding: file.encoding === 'base64' ? 'base64' : 'utf-8' });
      return { path: file.path, mode: mode as '100644' | '100755', type: 'blob' as const, sha: blob.data.sha };
    }));
    return (await octokit.git.createTree({ ...location, base_tree: baseCommit.data.tree.sha, tree })).data.sha;
  }

  async publishSubmission(task: Task, project: Project, files: PackageFile[], review: DeliveryReview, userCredential?: string,
    operation?: { id: string; headSha: string; checkpoint(): Promise<void>; recordTree?(treeSha: string): Promise<void> }): Promise<string | null> {
    if (files.length === 0) return null;
    const octokit = await this.client(userCredential);
    const baseBranch = task.targetBranch || project.sourceBranch || project.defaultBranch;
    const branch = this.taskBranch(task);
    let branchExists = true;
    let workingSha: string;
    try {
      workingSha = (await octokit.git.getRef({ owner: project.repoOwner, repo: project.repoName, ref: `heads/${branch}` })).data.object.sha;
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      branchExists = false;
      workingSha = task.baseSha;
    }
    // The package is a complete diff against the frozen task base, not against the
    // last submitted tree. Keep commit ancestry, but rebuild the submitted snapshot.
    const treeSha = await this.createSubmissionTree(octokit, task, project, files);
    await operation?.recordTree?.(treeSha);
    const currentCommit = operation ? (await octokit.git.getCommit({ owner: project.repoOwner, repo: project.repoName, commit_sha: workingSha })).data : null;
    // A lost response after pushing is recovered by comparing the full tree.
    // Otherwise only replace the head the submitting workspace actually synced.
    const alreadyPushed = currentCommit?.tree.sha === treeSha;
    if (!alreadyPushed) {
      if (operation && workingSha !== operation.headSha) throw httpError('远程任务分支已变化，请同步工作环境后重新交付。', 409, 'WORKSPACE_BEHIND');
      await operation?.checkpoint();
      const commit = await octokit.git.createCommit({
        owner: project.repoOwner, repo: project.repoName,
        message: `complete: ${task.title}${operation ? `\n\nTechunter-Submission: ${operation.id}` : ''}`,
        tree: treeSha, parents: [workingSha],
      });
      await operation?.checkpoint();
      if (branchExists) await octokit.git.updateRef({ owner: project.repoOwner, repo: project.repoName, ref: `heads/${branch}`, sha: commit.data.sha, force: false });
      else await octokit.git.createRef({ owner: project.repoOwner, repo: project.repoName, ref: `refs/heads/${branch}`, sha: commit.data.sha });
    }
    const pulls = await octokit.pulls.list({ owner: project.repoOwner, repo: project.repoName, state: 'open', head: `${project.repoOwner}:${branch}` });
    let url: string | undefined = pulls.data[0]?.html_url;
    if (!url && operation && alreadyPushed) {
      // A maintainer may merge the PR while the original request is interrupted.
      // Recover that exact snapshot, then let normal acceptance settle it.
      const previous = await octokit.paginate(octokit.pulls.list, { owner: project.repoOwner, repo: project.repoName, state: 'closed', head: `${project.repoOwner}:${branch}`, base: baseBranch, per_page: 100 });
      url = previous.find(pull => pull.merged_at && pull.head.sha === workingSha)?.html_url;
    }
    if (!url) {
      await operation?.checkpoint();
      const pull = await octokit.pulls.create({
        owner: project.repoOwner,
        repo: project.repoName,
        head: branch,
        base: baseBranch,
        title: task.title,
        body: [
          task.githubIssueNumber ? `Closes #${task.githubIssueNumber}` : '',
          '',
          '## Techunter AI 预审',
          `**${review.score}/100 · ${review.verdict === 'approved' ? '通过' : '需要修改'}**`,
          '',
          review.summary,
          '',
          `<!-- techunter-task-id:${task.id} -->`,
        ].join('\n'),
      });
      url = pull.data.html_url;
    }
    if (task.githubIssueNumber) {
      await operation?.checkpoint();
      await octokit.issues.update({ owner: project.repoOwner, repo: project.repoName, issue_number: task.githubIssueNumber, labels: [review.verdict === 'approved' ? taskLabels.inReview : taskLabels.changesNeeded] });
      const marker = operation ? `<!-- techunter-submission:${operation.id} -->` : '';
      const comments = operation ? await octokit.paginate(octokit.issues.listComments, { owner: project.repoOwner, repo: project.repoName, issue_number: task.githubIssueNumber, per_page: 100 }) : [];
      if (!marker || !comments.some(comment => comment.body?.includes(marker))) {
        await operation?.checkpoint();
        await octokit.issues.createComment({ owner: project.repoOwner, repo: project.repoName, issue_number: task.githubIssueNumber, body: `## AI 预审 · ${review.score}/100\n\n${review.summary}\n\nPR: ${url}\n${marker}` });
      }
    }
    return url ?? null;
  }

  async completeTask(task: Task, project: Project, pullRequestUrl: string | null, userCredential?: string, reviewed?: { treeSha: string; beforeMerge(): Promise<void> }): Promise<void> {
    const octokit = await this.client(userCredential);
    const match = pullRequestUrl?.match(/\/pull\/(\d+)/);
    if (!match || !task.scope) throw httpError('任务缺少可校验的 PR 或文件范围。', 409);
    const location = { owner: project.repoOwner, repo: project.repoName, pull_number: Number(match[1]) };
    const pull = (await octokit.pulls.get(location)).data;
    const expectedBranch = task.githubIssueNumber && task.assignee?.githubLogin
      ? makeTaskBranchName(task.githubIssueNumber, task.assignee.githubLogin) : `task-${task.id.slice(0, 8)}`;
    if ((pull.state !== 'open' && !pull.merged) || pull.base.ref !== task.targetBranch || pull.head.ref !== expectedBranch || pull.head.repo?.id !== project.githubRepositoryId) {
      throw httpError('PR 状态、目标分支或来源仓库与任务不一致。', 409, 'PULL_SCOPE_INVALID');
    }
    const expectedTree = reviewed?.treeSha ?? task.latestSubmission?.reviewedTreeSha;
    if (!expectedTree) throw httpError('提交缺少已审核的代码快照，请重新交付。', 409, 'PULL_REVIEW_MISSING');
    const commit = await octokit.git.getCommit({ owner: project.repoOwner, repo: project.repoName, commit_sha: pull.head.sha });
    if (commit.data.tree.sha !== expectedTree) throw httpError('PR 代码已在预审后变化，请要求重新交付并审核。', 409, 'PULL_REVIEW_OUTDATED');
    const files = await octokit.paginate(octokit.pulls.listFiles, { ...location, per_page: 100 });
    assertPullFilesInScope(files, pull.changed_files, task.scope);
    // Reject concurrent pushes during pagination and pin the merge to the checked head.
    const latest = (await octokit.pulls.get(location)).data;
    if (latest.head.sha !== pull.head.sha || latest.base.sha !== pull.base.sha || latest.base.ref !== pull.base.ref) throw httpError('PR 在范围校验期间发生变化，请重新验收。', 409);
    await reviewed?.beforeMerge();
    if (!latest.merged) {
      const merged = await octokit.pulls.merge({ ...location, sha: pull.head.sha, merge_method: 'merge' });
      if (!merged.data.merged) throw httpError('GitHub 尚未合并 PR，请处理合并限制后重新验收。', 409);
    }
    if (task.githubIssueNumber) await octokit.issues.update({ owner: project.repoOwner, repo: project.repoName, issue_number: task.githubIssueNumber, state: 'closed', labels: [] });
  }

  async cancelTask(task: Task, project: Project, userCredential?: string): Promise<void> {
    const octokit = await this.client(userCredential);
    const pullRequestNumber = task.latestSubmission?.pullRequestUrl?.match(/\/pull\/(\d+)/)?.[1];
    if (pullRequestNumber) {
      await octokit.pulls.update({
        owner: project.repoOwner,
        repo: project.repoName,
        pull_number: Number(pullRequestNumber),
        state: 'closed',
      });
    }
    if (task.githubIssueNumber) {
      await octokit.issues.update({
        owner: project.repoOwner,
        repo: project.repoName,
        issue_number: task.githubIssueNumber,
        state: 'closed',
        state_reason: 'not_planned',
        assignees: [],
        labels: [],
      });
    }
  }

  private async ensureLabels(octokit: Octokit, owner: string, repo: string): Promise<void> {
    const existing = await octokit.paginate(octokit.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
    const names = new Set(existing.map((label) => label.name));
    await Promise.all(taskLabelDefinitions.filter((label) => !names.has(label.name)).map((label) => octokit.issues.createLabel({ owner, repo, ...label }).catch(() => undefined)));
  }
}
