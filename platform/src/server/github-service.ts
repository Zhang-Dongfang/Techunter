import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type { ReviewResult, Task } from '../shared/contracts.js';
import { config } from './config.js';
import type { PackageFile } from './workspace-service.js';

const LABELS = [
  { name: 'techunter:open', color: '1f6feb', description: 'Techunter task is open' },
  { name: 'techunter:active', color: 'd29922', description: 'Techunter task is active' },
  { name: 'techunter:submitted', color: 'a371f7', description: 'Techunter task has a submission' },
  { name: 'techunter:changes-requested', color: 'f85149', description: 'Techunter task needs changes' },
];

export class GitHubService {
  get configured(): boolean {
    return Boolean(config.github.token || (config.github.appId && config.github.installationId && config.github.privateKey));
  }

  private async client(): Promise<Octokit | null> {
    if (config.github.appId && config.github.installationId && config.github.privateKey) {
      const auth = createAppAuth({
        appId: config.github.appId,
        privateKey: config.github.privateKey,
        installationId: Number(config.github.installationId),
      });
      const installation = await auth({ type: 'installation' });
      return new Octokit({ auth: installation.token });
    }
    return config.github.token ? new Octokit({ auth: config.github.token }) : null;
  }

  async createIssue(task: Task, repo: { owner: string; name: string }): Promise<{ number: number; url: string } | null> {
    const octokit = await this.client();
    if (!octokit) return null;
    await this.ensureLabels(octokit, repo.owner, repo.name);
    const body = [
      task.summary || task.description,
      '',
      '## 验收标准',
      ...task.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`),
      '',
      `**贡献点：** ${task.rewardPoints}`,
      '',
      `<!-- techunter task_id=${task.id} -->`,
    ].join('\n');
    const { data } = await octokit.issues.create({
      owner: repo.owner,
      repo: repo.name,
      title: task.title,
      body,
      labels: ['techunter:open'],
    });
    return { number: data.number, url: data.html_url };
  }

  async syncClaim(task: Task, repo: { owner: string; name: string }, githubLogin: string): Promise<void> {
    const octokit = await this.client();
    if (!octokit || !task.githubIssueNumber) return;
    await octokit.issues.update({
      owner: repo.owner,
      repo: repo.name,
      issue_number: task.githubIssueNumber,
      assignees: [githubLogin],
      labels: ['techunter:active'],
    });
  }

  async publishSubmission(
    task: Task,
    repo: { owner: string; name: string; defaultBranch: string },
    files: PackageFile[],
    review: ReviewResult,
  ): Promise<string | null> {
    const octokit = await this.client();
    if (!octokit || files.length === 0) return null;
    const baseBranch = task.targetBranch || repo.defaultBranch;
    const branch = `tch/task-${task.id.slice(0, 8)}`;
    let branchExists = true;
    let workingRef;
    try {
      workingRef = await octokit.git.getRef({ owner: repo.owner, repo: repo.name, ref: `heads/${branch}` });
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      branchExists = false;
      try {
        workingRef = await octokit.git.getRef({ owner: repo.owner, repo: repo.name, ref: `heads/${baseBranch}` });
      } catch (baseError) {
        if (!task.parentTaskId || (baseError as { status?: number }).status !== 404) throw baseError;
        const defaultRef = await octokit.git.getRef({ owner: repo.owner, repo: repo.name, ref: `heads/${repo.defaultBranch}` });
        await octokit.git.createRef({
          owner: repo.owner,
          repo: repo.name,
          ref: `refs/heads/${baseBranch}`,
          sha: defaultRef.data.object.sha,
        });
        workingRef = await octokit.git.getRef({ owner: repo.owner, repo: repo.name, ref: `heads/${baseBranch}` });
      }
    }
    const baseCommit = await octokit.git.getCommit({ owner: repo.owner, repo: repo.name, commit_sha: workingRef.data.object.sha });
    const treeItems = await Promise.all(files.map(async (file) => {
      if (file.content === null) return { path: file.path, mode: '100644' as const, type: 'blob' as const, sha: null };
      const blob = await octokit.git.createBlob({
        owner: repo.owner,
        repo: repo.name,
        content: file.content,
        encoding: file.encoding === 'base64' ? 'base64' : 'utf-8',
      });
      return { path: file.path, mode: '100644' as const, type: 'blob' as const, sha: blob.data.sha };
    }));
    const tree = await octokit.git.createTree({
      owner: repo.owner,
      repo: repo.name,
      base_tree: baseCommit.data.tree.sha,
      tree: treeItems,
    });
    const commit = await octokit.git.createCommit({
      owner: repo.owner,
      repo: repo.name,
      message: `complete: ${task.title}`,
      tree: tree.data.sha,
      parents: [workingRef.data.object.sha],
    });
    if (branchExists) {
      await octokit.git.updateRef({ owner: repo.owner, repo: repo.name, ref: `heads/${branch}`, sha: commit.data.sha, force: false });
    } else {
      await octokit.git.createRef({ owner: repo.owner, repo: repo.name, ref: `refs/heads/${branch}`, sha: commit.data.sha });
    }
    const openPulls = await octokit.pulls.list({ owner: repo.owner, repo: repo.name, state: 'open', head: `${repo.owner}:${branch}` });
    let url = openPulls.data[0]?.html_url;
    if (!url) {
      const pull = await octokit.pulls.create({
        owner: repo.owner,
        repo: repo.name,
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
          `<!-- techunter task_id=${task.id} -->`,
        ].join('\n'),
      });
      url = pull.data.html_url;
    }
    if (task.githubIssueNumber) {
      await octokit.issues.update({
        owner: repo.owner,
        repo: repo.name,
        issue_number: task.githubIssueNumber,
        labels: [review.verdict === 'approved' ? 'techunter:submitted' : 'techunter:changes-requested'],
      });
      await octokit.issues.createComment({
        owner: repo.owner,
        repo: repo.name,
        issue_number: task.githubIssueNumber,
        body: `## AI 预审 · ${review.score}/100\n\n${review.summary}\n\nPR: ${url}`,
      });
    }
    return url ?? null;
  }

  async completeTask(task: Task, repo: { owner: string; name: string }, pullRequestUrl: string | null): Promise<void> {
    const octokit = await this.client();
    if (!octokit) return;
    if (pullRequestUrl) {
      const match = pullRequestUrl.match(/\/pull\/(\d+)/);
      if (match) {
        await octokit.pulls.merge({ owner: repo.owner, repo: repo.name, pull_number: Number(match[1]), merge_method: 'merge' });
      }
    }
    if (task.githubIssueNumber) {
      await octokit.issues.update({ owner: repo.owner, repo: repo.name, issue_number: task.githubIssueNumber, state: 'closed', labels: [] });
    }
  }

  private async ensureLabels(octokit: Octokit, owner: string, repo: string): Promise<void> {
    const existing = await octokit.paginate(octokit.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
    const names = new Set(existing.map((label) => label.name));
    await Promise.all(LABELS.filter((label) => !names.has(label.name)).map((label) =>
      octokit.issues.createLabel({ owner, repo, ...label }).catch(() => undefined)
    ));
  }
}
