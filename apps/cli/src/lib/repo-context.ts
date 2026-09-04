import type { RepoContext, TaskState } from '../types.js';
import { hasCommitsNotInBranch, hasUncommittedChanges, resolveBranchRef } from './git.js';

export async function observeRepoContext(
  currentBranch: string,
  targetBranch: string,
  previousTaskState?: TaskState,
): Promise<RepoContext> {
  const hasWorkingTreeChanges = await hasUncommittedChanges();
  const targetCompareRef = (await resolveBranchRef(targetBranch)) ?? targetBranch;

  let hasSourceOnlyCommits = false;
  try {
    hasSourceOnlyCommits = await hasCommitsNotInBranch(currentBranch, targetCompareRef);
  } catch {
    hasSourceOnlyCommits = false;
  }

  return {
    currentBranch,
    targetBranch,
    hasWorkingTreeChanges,
    hasSourceOnlyCommits,
    previousTaskState,
  };
}
