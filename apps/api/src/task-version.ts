import { makeTaskBranchName } from '@techunter/core';

export interface ProjectVersionSource {
  sourceBranch: string;
  headSha: string;
}

export interface ParentTaskVersionSource {
  githubIssueNumber: number | null;
  assignee: { githubLogin: string | null } | null;
}

export async function resolveTaskVersion(
  project: ProjectVersionSource,
  parent: ParentTaskVersionSource | null,
  latestBranchHead: (branch: string) => Promise<string>,
): Promise<{ baseSha: string; targetBranch: string }> {
  if (!parent) return { baseSha: project.headSha, targetBranch: project.sourceBranch };
  if (parent.githubIssueNumber === null || !parent.assignee?.githubLogin) {
    throw new Error('母任务还没有可同步的远程任务分支。');
  }
  const targetBranch = makeTaskBranchName(parent.githubIssueNumber, parent.assignee.githubLogin);
  return { baseSha: await latestBranchHead(targetBranch), targetBranch };
}
