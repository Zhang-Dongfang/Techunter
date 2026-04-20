import chalk from 'chalk';
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


export function makeWorkerBranchName(username: string): string {
  const slug = username.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'user';
  return `worker-${slug}`;
}

export function makeTaskBranchName(issueNumber: number, username: string): string {
  const slug = username.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'user';
  return `task-${issueNumber}-${slug}`;
}

export function isTaskBranch(branch: string): boolean {
  return /^task-\d+-/.test(branch);
}

export function parseIssueNumberFromBranch(branch: string): number | null {
  const match = branch.match(/^task-(\d+)-/);
  return match ? parseInt(match[1], 10) : null;
}

export async function getCurrentCommit(): Promise<string> {
  return (await git.revparse(['HEAD'])).trim();
}

export async function switchToBranchOrCreate(name: string): Promise<boolean> {
  try {
    const branches = await git.branch(['-a']);
    const exists = Object.keys(branches.branches).some(
      (b) => b === name || b === `remotes/origin/${name}`
    );
    if (exists) {
      await git.checkout(name);
      return false;
    }
    await git.checkoutLocalBranch(name);
    return true;
  } catch {
    await git.checkoutLocalBranch(name);
    return true;
  }
}

export async function resolveBranchRef(name: string): Promise<string | null> {
  const branches = await git.branch(['-a']);
  if (Object.prototype.hasOwnProperty.call(branches.branches, name)) return name;
  if (Object.prototype.hasOwnProperty.call(branches.branches, `remotes/origin/${name}`)) return `origin/${name}`;
  return null;
}

export async function hasCommitsNotInBranch(sourceBranch: string, targetBranch: string): Promise<boolean> {
  const count = await git.raw(['rev-list', '--count', `${targetBranch}..${sourceBranch}`]);
  return parseInt(count.trim(), 10) > 0;
}

export async function squashMergeBranch(sourceBranch: string): Promise<void> {
  await git.merge(['--squash', sourceBranch]);
}

export async function abortMergeOperation(): Promise<void> {
  try {
    await git.raw(['merge', '--abort']);
    return;
  } catch {
    // Fall through to reset --merge, which also clears conflicted merge state.
  }

  try {
    await git.raw(['reset', '--merge']);
  } catch {
    // Nothing to abort, or Git cannot cleanly abort here.
  }
}

async function countCommits(range: string): Promise<number> {
  const count = await git.raw(['rev-list', '--count', range]);
  return parseInt(count.trim(), 10);
}

export async function syncBranchWithRemote(
  branchName: string
): Promise<{ mode: 'noop' | 'fast-forward' | 'merge' }> {
  try {
    await git.fetch('origin', branchName);
  } catch {
    return { mode: 'noop' };
  }

  const remoteRef = `origin/${branchName}`;
  const branches = await git.branch(['-a']);
  if (!Object.prototype.hasOwnProperty.call(branches.branches, `remotes/${remoteRef}`)) {
    return { mode: 'noop' };
  }

  const [localAhead, remoteAhead] = await Promise.all([
    countCommits(`${remoteRef}..${branchName}`),
    countCommits(`${branchName}..${remoteRef}`),
  ]);

  if (remoteAhead === 0) return { mode: 'noop' };

  if (localAhead === 0) {
    await git.merge(['--ff-only', remoteRef]);
    return { mode: 'fast-forward' };
  }

  try {
    await git.merge([remoteRef, '-m', `chore: sync ${branchName} after remote update`]);
    return { mode: 'merge' };
  } catch (err) {
    await abortMergeOperation();
    throw new Error(`Could not sync ${branchName} with ${remoteRef}: ${(err as Error).message}`);
  }
}

export async function getDiffFromCommit(baseCommit: string): Promise<string> {
  const status = await git.status();
  const parts: string[] = [];

  const fileLines = [
    ...status.modified.map((f) => `  M  ${f}`),
    ...status.created.map((f) => `  A  ${f}`),
    ...status.deleted.map((f) => `  D  ${f}`),
    ...status.renamed.map((f) => `  R  ${f.from} → ${f.to}`),
    ...status.not_added.map((f) => `  ?  ${f}`),
  ];
  if (fileLines.length > 0) {
    parts.push('## Uncommitted changes\n' + fileLines.join('\n'));
    const uncommitted = await git.diff(['HEAD']);
    if (uncommitted) {
      const capped = uncommitted.length > 8_000 ? uncommitted.slice(0, 8_000) + '\n... (truncated)' : uncommitted;
      parts.push('## Uncommitted diff\n```diff\n' + capped + '\n```');
    }
  }

  const log = await git.log({ from: baseCommit, to: 'HEAD' });
  if (log.total > 0) {
    const logLines = log.all.map((c) => `  ${c.hash.slice(0, 7)}  ${c.message}`);
    parts.push(`## Commits since task claimed (${log.total} total)\n` + logLines.join('\n'));

    const branchDiff = await git.diff([baseCommit, 'HEAD']);
    if (branchDiff) {
      const capped = branchDiff.length > 12_000 ? branchDiff.slice(0, 12_000) + '\n... (truncated)' : branchDiff;
      parts.push('## Full diff since task claimed\n```diff\n' + capped + '\n```');
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : 'No changes since task was claimed.';
}

async function findMergeBase(configuredBase?: string): Promise<string | null> {
  const candidates = configuredBase
    ? [`origin/${configuredBase}`, 'origin/main', 'origin/master']
    : ['origin/main', 'origin/master'];
  const unique = [...new Set(candidates)];
  for (const base of unique) {
    try {
      const result = await git.raw(['merge-base', 'HEAD', base]);
      return result.trim();
    } catch {
      // try next
    }
  }
  return null;
}

export async function getDiff(baseBranch?: string): Promise<string> {
  const status = await git.status();
  const parts: string[] = [];

  // Uncommitted changes
  const fileLines = [
    ...status.modified.map((f) => `  M  ${f}`),
    ...status.created.map((f) => `  A  ${f}`),
    ...status.deleted.map((f) => `  D  ${f}`),
    ...status.renamed.map((f) => `  R  ${f.from} → ${f.to}`),
    ...status.not_added.map((f) => `  ?  ${f}`),
  ];
  if (fileLines.length > 0) {
    parts.push('## Uncommitted changes\n' + fileLines.join('\n'));
    const uncommitted = await git.diff(['HEAD']);
    if (uncommitted) {
      const capped = uncommitted.length > 8_000 ? uncommitted.slice(0, 8_000) + '\n... (truncated)' : uncommitted;
      parts.push('## Uncommitted diff\n```diff\n' + capped + '\n```');
    }
  }

  // All commits and changes on this branch since it diverged from base branch
  const mergeBase = await findMergeBase(baseBranch);
  if (mergeBase) {
    const log = await git.log({ from: mergeBase, to: 'HEAD' });
    if (log.total > 0) {
      const logLines = log.all.map((c) => `  ${c.hash.slice(0, 7)}  ${c.message}`);
      parts.push(`## Branch commits (${log.total} total)\n` + logLines.join('\n'));

      const branchDiff = await git.diff([mergeBase, 'HEAD']);
      if (branchDiff) {
        const capped = branchDiff.length > 12_000 ? branchDiff.slice(0, 12_000) + '\n... (truncated)' : branchDiff;
        parts.push('## Full branch diff vs main\n```diff\n' + capped + '\n```');
      }
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : 'No changes detected.';
}

export async function stageAllAndCommit(message: string): Promise<void> {
  const status = await git.status();
  if (!status.isClean()) {
    await git.add('.');
    await git.commit(message);
  } else {
    console.log(chalk.dim('  Working tree clean — no new commit created, pushing existing commits.'));
  }
  const branch = (await git.branch()).current;
  await git.push('origin', branch, ['--set-upstream']);
}

export async function syncWithBase(baseBranch: string): Promise<void> {
  await git.fetch('origin', baseBranch);
  try {
    await git.merge([`origin/${baseBranch}`, '--ff-only']);
  } catch {
    await git.merge([`origin/${baseBranch}`, '-m', `chore: sync with ${baseBranch}`]);
  }
}

export async function getRemoteHeadSha(baseBranch: string): Promise<string> {
  await git.fetch('origin', baseBranch);
  return (await git.revparse([`origin/${baseBranch}`])).trim();
}

export async function checkoutFromCommit(branchName: string, sha: string): Promise<void> {
  const branches = await git.branch(['-a']);
  const exists = Object.keys(branches.branches).some(
    (b) => b === branchName || b === `remotes/origin/${branchName}`
  );
  if (exists) {
    await git.checkout(branchName);
  } else {
    await git.checkoutBranch(branchName, sha);
  }
}

export async function resetOrCreateBranch(branchName: string, sha: string): Promise<void> {
  const branches = await git.branch(['-a']);
  const localExists = Object.keys(branches.branches).some((b) => b === branchName);
  if (localExists) {
    await git.checkout(branchName);
    await git.reset(['--hard', sha]);
  } else {
    await git.checkoutBranch(branchName, sha);
  }
}

export async function hasUncommittedChanges(): Promise<boolean> {
  const status = await git.status();
  return !status.isClean();
}

export async function stash(message: string): Promise<void> {
  await git.stash(['push', '-u', '-m', message]);
}

export async function stashPop(): Promise<void> {
  await git.stash(['pop']);
}

export async function getCurrentRepoRoot(): Promise<string> {
  return git.revparse(['--show-toplevel']);
}
