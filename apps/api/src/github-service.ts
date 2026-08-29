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
  type GitHubRepositoryCandidate,
  type PackageFile,
  type Project,
  type Task,
  type DeliveryReview,
} from '@techunter/core';
import { config } from './config.js';
import { httpError } from './errors.js';

function visibility(value: unknown, privateRepository: boolean): GitHubRepositoryCandidate['visibility'] {
  if (value === 'internal') return 'internal';
  return privateRepository ? 'private' : 'public';
}

export class GitHubService {
  get configured(): boolean {
    const value = config().github;
    return Boolean(value.clientId || (value.appId && value.installationId && value.privateKey));
  }

  private async installationClient(): Promise<{ octokit: Octokit; token: string; expiresAt: string }> {
    const value = config().github;
    if (value.appId && value.installationId && value.privateKey) {
      const auth = createAppAuth({
        appId: value.appId,
        installationId: Number(value.installationId),
        privateKey: value.privateKey,
      });
      const installation = await auth({ type: 'installation' });
      return { octokit: new Octokit({ auth: installation.token }), token: installation.token, expiresAt: installation.expiresAt };
    }
    throw httpError('没有可用于该 GitHub 仓库的授权。', 503, 'GITHUB_NOT_CONFIGURED');
  }

  private async client(userCredential?: string): Promise<Octokit> {
    if (userCredential) return new Octokit({ auth: userCredential });
    return (await this.installationClient()).octokit;
  }

  async checkoutAuthorization(project: Project, userCredential: string): Promise<{ token: string; expiresAt: string | null }> {
    try {
      await this.repository(project.githubRepositoryId, userCredential);
    } catch (error) {
      if ((error as { status?: number }).status === 404 && project.visibility !== 'public') {
        throw httpError('当前 GitHub 账号还不是该私有仓库的合作者。', 403, 'GITHUB_COLLABORATOR_REQUIRED');
      }
      throw error;
    }
    const value = config().github;
    if (value.appId && value.installationId && value.privateKey) {
      try {
        const installation = await this.installationClient();
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

  async repository(repositoryId: number, userCredential: string): Promise<GitHubRepositoryCandidate & { headSha: string }> {
    const octokit = await this.client(userCredential);
    const response = await octokit.request('GET /repositories/{repository_id}', { repository_id: repositoryId });
    const repo = response.data;
    const head = await octokit.git.getRef({ owner: repo.owner.login, repo: repo.name, ref: `heads/${repo.default_branch}` });
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

  async materialize(project: Project, userCredential?: string): Promise<{ root: string; cleanup(): Promise<void> }> {
    const octokit = await this.client(userCredential);
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'techunter-repo-'));
    const archive = path.join(tempRoot, 'repository.tar.gz');
    const root = path.join(tempRoot, 'repo');
    await fs.mkdir(root);
    try {
      const response = await octokit.request('GET /repos/{owner}/{repo}/tarball/{ref}', {
        owner: project.repoOwner,
        repo: project.repoName,
        ref: project.headSha || project.defaultBranch,
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

  async createIssue(task: Task, project: Project, userCredential?: string): Promise<{ number: number; url: string }> {
    const octokit = await this.client(userCredential);
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
    const { data } = await octokit.issues.create({
      owner: project.repoOwner,
      repo: project.repoName,
      title: task.title,
      body,
      labels: [taskLabels.available],
    });
    return { number: data.number, url: data.html_url };
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

  async publishSubmission(task: Task, project: Project, files: PackageFile[], review: DeliveryReview, userCredential?: string): Promise<string | null> {
    if (files.length === 0) return null;
    const octokit = await this.client(userCredential);
    const baseBranch = task.targetBranch || project.defaultBranch;
    const branch = task.githubIssueNumber && task.assignee?.githubLogin
      ? makeTaskBranchName(task.githubIssueNumber, task.assignee.githubLogin)
      : `task-${task.id.slice(0, 8)}`;
    let branchExists = true;
    let workingSha: string;
    try {
      workingSha = (await octokit.git.getRef({ owner: project.repoOwner, repo: project.repoName, ref: `heads/${branch}` })).data.object.sha;
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      branchExists = false;
      workingSha = task.baseSha;
    }
    const baseCommit = await octokit.git.getCommit({ owner: project.repoOwner, repo: project.repoName, commit_sha: workingSha });
    const treeItems = await Promise.all(files.map(async (file) => {
      if (file.content === null) return { path: file.path, mode: '100644' as const, type: 'blob' as const, sha: null };
      const blob = await octokit.git.createBlob({
        owner: project.repoOwner,
        repo: project.repoName,
        content: file.content,
        encoding: file.encoding === 'base64' ? 'base64' : 'utf-8',
      });
      return { path: file.path, mode: '100644' as const, type: 'blob' as const, sha: blob.data.sha };
    }));
    const tree = await octokit.git.createTree({ owner: project.repoOwner, repo: project.repoName, base_tree: baseCommit.data.tree.sha, tree: treeItems });
    const commit = await octokit.git.createCommit({
      owner: project.repoOwner,
      repo: project.repoName,
      message: `complete: ${task.title}`,
      tree: tree.data.sha,
      parents: [workingSha],
    });
    if (branchExists) await octokit.git.updateRef({ owner: project.repoOwner, repo: project.repoName, ref: `heads/${branch}`, sha: commit.data.sha, force: false });
    else await octokit.git.createRef({ owner: project.repoOwner, repo: project.repoName, ref: `refs/heads/${branch}`, sha: commit.data.sha });
    const pulls = await octokit.pulls.list({ owner: project.repoOwner, repo: project.repoName, state: 'open', head: `${project.repoOwner}:${branch}` });
    let url = pulls.data[0]?.html_url;
    if (!url) {
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
      await octokit.issues.update({ owner: project.repoOwner, repo: project.repoName, issue_number: task.githubIssueNumber, labels: [review.verdict === 'approved' ? taskLabels.inReview : taskLabels.changesNeeded] });
      await octokit.issues.createComment({ owner: project.repoOwner, repo: project.repoName, issue_number: task.githubIssueNumber, body: `## AI 预审 · ${review.score}/100\n\n${review.summary}\n\nPR: ${url}` });
    }
    return url ?? null;
  }

  async completeTask(task: Task, project: Project, pullRequestUrl: string | null, userCredential?: string): Promise<void> {
    const octokit = await this.client(userCredential);
    const match = pullRequestUrl?.match(/\/pull\/(\d+)/);
    if (match) await octokit.pulls.merge({ owner: project.repoOwner, repo: project.repoName, pull_number: Number(match[1]), merge_method: 'merge' });
    if (task.githubIssueNumber) await octokit.issues.update({ owner: project.repoOwner, repo: project.repoName, issue_number: task.githubIssueNumber, state: 'closed', labels: [] });
  }

  private async ensureLabels(octokit: Octokit, owner: string, repo: string): Promise<void> {
    const existing = await octokit.paginate(octokit.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
    const names = new Set(existing.map((label) => label.name));
    await Promise.all(taskLabelDefinitions.filter((label) => !names.has(label.name)).map((label) => octokit.issues.createLabel({ owner, repo, ...label }).catch(() => undefined)));
  }
}
