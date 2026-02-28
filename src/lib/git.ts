import { simpleGit } from 'simple-git';

const git = simpleGit();

export async function getCurrentBranch(): Promise<string> {
  const summary = await git.branch();
  return summary.current;
}

export async function createAndSwitchBranch(name: string): Promise<void> {
  await git.checkoutLocalBranch(name);
}

export async function pushBranch(name: string): Promise<void> {
  await git.push('origin', name, ['--set-upstream']);
}

export async function getRemoteUrl(): Promise<string | null> {
  try {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin');
    return origin?.refs?.fetch ?? null;
  } catch {
    return null;
  }
}

export function parseOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/([^.]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/https?:\/\/github\.com\/([^/]+)\/([^.]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  return null;
}

export function makeBranchName(issueNumber: number, title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join('-');

  return `task-${issueNumber}-${words}`;
}

export async function hasUncommittedChanges(): Promise<boolean> {
  const status = await git.status();
  return !status.isClean();
}

export async function getCurrentRepoRoot(): Promise<string> {
  return git.revparse(['--show-toplevel']);
}
