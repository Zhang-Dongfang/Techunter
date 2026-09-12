import type { Octokit } from '@octokit/rest';

export const claimLockRef = (number: number): string => `heads/techunter-claims/issue-${number}`;

/** GitHub creates a ref only once, providing an atomic winner across CLI processes.
 * Keep the ref on an uncertain outcome; the same user can resume after a restart.
 */
export async function acquireClaimLock(octokit: Octokit, owner: string, repo: string, number: number, username: string): Promise<void> {
  const location = { owner, repo };
  const repository = (await octokit.repos.get(location)).data;
  const head = (await octokit.git.getRef({ ...location, ref: `heads/${repository.default_branch}` })).data.object.sha;
  const base = (await octokit.git.getCommit({ ...location, commit_sha: head })).data;
  const message = `Techunter claim #${number}\nOwner: ${username.toLowerCase()}`;
  const commit = (await octokit.git.createCommit({ ...location, tree: base.tree.sha, parents: [head], message })).data;
  try {
    await octokit.git.createRef({ ...location, ref: `refs/${claimLockRef(number)}`, sha: commit.sha });
  } catch (error) {
    let lock;
    try {
      const ref = await octokit.git.getRef({ ...location, ref: claimLockRef(number) });
      lock = (await octokit.git.getCommit({ ...location, commit_sha: ref.data.object.sha })).data;
    } catch { throw error; }
    if (lock.message.trim() !== message) throw new Error(`Task #${number} is already being claimed by another user.`);
  }
}
