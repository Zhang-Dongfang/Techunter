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

export async function getDiff(): Promise<string> {
  const status = await git.status();
  const parts: string[] = [];

  // File summary
  const fileLines = [
    ...status.modified.map((f) => `  M  ${f}`),
    ...status.created.map((f) => `  A  ${f}`),
    ...status.deleted.map((f) => `  D  ${f}`),
    ...status.renamed.map((f) => `  R  ${f.from} → ${f.to}`),
    ...status.not_added.map((f) => `  ?  ${f}`),
  ];
  if (fileLines.length > 0) {
    parts.push('## Changed files\n' + fileLines.join('\n'));
  }

  // Uncommitted diff
  const diff = await git.diff(['HEAD']);
  if (diff) {
    const capped = diff.length > 10_000 ? diff.slice(0, 10_000) + '\n... (truncated)' : diff;
    parts.push('## Diff vs HEAD\n```diff\n' + capped + '\n```');
  }

  // Unpushed commits (if working tree is clean)
  if (fileLines.length === 0) {
    try {
      const log = await git.log({ from: '@{u}', to: 'HEAD' });
      if (log.total > 0) {
        const logLines = log.all.map((c) => `  ${c.hash.slice(0, 7)}  ${c.message}`);
        parts.push('## Unpushed commits\n' + logLines.join('\n'));
        const unpushedDiff = await git.diff(['@{u}', 'HEAD']);
        if (unpushedDiff) {
          const capped =
            unpushedDiff.length > 10_000
              ? unpushedDiff.slice(0, 10_000) + '\n... (truncated)'
              : unpushedDiff;
          parts.push('## Diff (unpushed)\n```diff\n' + capped + '\n```');
        }
      }
    } catch {
      // No upstream configured yet
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : 'No changes detected.';
}

export async function stageAllAndCommit(message: string): Promise<void> {
  await git.add('.');
  await git.commit(message);
  const branch = (await git.branch()).current;
  await git.push('origin', branch, ['--set-upstream']);
}

export async function hasUncommittedChanges(): Promise<boolean> {
  const status = await git.status();
  return !status.isClean();
}

export async function getCurrentRepoRoot(): Promise<string> {
  return git.revparse(['--show-toplevel']);
}
