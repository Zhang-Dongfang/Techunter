import { Octokit } from '@octokit/rest';
import type { TechunterConfig, GitHubIssue, TaskGuide } from '../types.js';
import { fetch as undiciFetch } from 'undici';
import { getUndiciProxyAgent } from './proxy.js';
import { makeTaskBranchName } from './git.js';
import { acquireClaimLock, claimLockRef } from './claim-lock.js';
import { acceptCentralTask, centralTask, isCentralTask, rejectCentralTask } from './central-api.js';
import {
  extractBaseCommit,
  extractTargetBranch,
  stripTaskMetadata,
  taskLabelDefinitions,
  taskLabels,
  taskStatusFromLabels,
  techunterTaskLabels,
  withTaskMetadata,
} from '@techunter/core';

const LABEL_AVAILABLE = taskLabels.available;
const LABEL_CLAIMED = taskLabels.claimed;
const LABEL_IN_REVIEW = taskLabels.inReview;
const LABEL_CHANGES_NEEDED = taskLabels.changesNeeded;
const LABELS = taskLabelDefinitions;

function createOctokit(token: string): Octokit {
  const agent = getUndiciProxyAgent();
  return new Octokit({
    auth: token,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    ...(agent && {
      request: {
        fetch: (url: string, opts?: Parameters<typeof undiciFetch>[1]) =>
          undiciFetch(url, { ...opts, dispatcher: agent }),
      },
    }),
  });
}

function parseIssue(issue: {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  user?: { login: string } | null;
  assignee?: { login: string } | null;
  labels?: Array<{ name?: string } | string>;
  html_url: string;
}): GitHubIssue {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    state: issue.state,
    author: issue.user?.login ?? null,
    assignee: issue.assignee?.login ?? null,
    labels: (issue.labels ?? []).map((l) =>
      typeof l === 'string' ? l : (l.name ?? '')
    ),
    htmlUrl: issue.html_url,
  };
}

function getIssueLabels(labels?: Array<{ name?: string } | string>): string[] {
  return (labels ?? []).map((label) => (typeof label === 'string' ? label : (label.name ?? '')));
}

function getTaskStatusFromLabels(labels?: Array<{ name?: string } | string>): string {
  return taskStatusFromLabels(getIssueLabels(labels));
}

function issueBodyClosesTask(body: string | null | undefined, issueNumber: number): boolean {
  return new RegExp(`Closes #${issueNumber}\\b`, 'i').test(body ?? '');
}

async function listOpenPullRequests(config: TechunterConfig) {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;
  return octokit.paginate(octokit.pulls.list, { owner, repo, state: 'open', per_page: 100 });
}

async function listRepoBranches(config: TechunterConfig) {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;
  return octokit.paginate(octokit.repos.listBranches, { owner, repo, per_page: 100 });
}

export async function listTasks(config: TechunterConfig): Promise<GitHubIssue[]> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  const data = await octokit.paginate(octokit.issues.listForRepo, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });

  return data
    .filter((issue) =>
      !issue.pull_request &&
      (issue.labels as Array<{ name?: string }>).some((l) => techunterTaskLabels.has(l.name ?? ''))
    )
    .map(parseIssue)
    .sort((a, b) => a.number - b.number);
}

export async function getTask(config: TechunterConfig, number: number): Promise<GitHubIssue> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  const { data } = await octokit.issues.get({ owner, repo, issue_number: number });
  return parseIssue(data);
}

export { embedBaseCommit, embedTargetBranch, extractBaseCommit, extractTargetBranch, stripTaskMetadata } from '@techunter/core';

export async function createTask(
  config: TechunterConfig,
  title: string,
  body?: string,
  baseCommit?: string,
  targetBranch?: string
): Promise<GitHubIssue> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  const parentNumber = targetBranch?.match(/^task-(\d+)-/)?.[1];
  if (parentNumber && isCentralTask(await getTask(config, Number(parentNumber)))) {
    throw new Error('中央任务的子任务需要通过 Desktop 创建，以校验父任务权限、文件范围和预算。');
  }
  await ensureLabels(config);

  const finalBody = withTaskMetadata({ body: body ?? '', baseCommit, targetBranch });

  const { data } = await octokit.issues.create({
    owner,
    repo,
    title,
    body: finalBody,
    labels: [LABEL_AVAILABLE],
  });

  return parseIssue(data);
}

export async function mergeBranchIntoBase(
  config: TechunterConfig,
  headBranch: string,
  baseBranch: string
): Promise<void> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;
  try {
    await octokit.repos.merge({
      owner,
      repo,
      base: baseBranch,
      head: headBranch,
      commit_message: `chore: merge ${headBranch} into ${baseBranch}`,
    });
  } catch (err: unknown) {
    if ((err as { status?: number }).status === 409) {
      throw new Error(
        `Merge conflict: ${headBranch} cannot be merged into ${baseBranch} cleanly. Resolve conflicts manually.`
      );
    }
    throw err;
  }
}

export async function mergeWorkerIntoBase(
  config: TechunterConfig,
  workerBranch: string,
  baseBranch: string
): Promise<void> {
  await mergeBranchIntoBase(config, workerBranch, baseBranch);
}

export async function claimTask(
  config: TechunterConfig,
  number: number,
  username: string
): Promise<void> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  const { data: issue } = await octokit.issues.get({ owner, repo, issue_number: number });
  if (isCentralTask({ body: issue.body ?? null })) {
    const { client, task } = await centralTask(config, { body: issue.body ?? null, number });
    await client.request(`/api/tasks/${task.id}/claim`, 'POST', {});
    return;
  }
  const issueLabels = getIssueLabels(issue.labels as Array<{ name?: string } | string>);
  const currentStatus = getTaskStatusFromLabels(issue.labels as Array<{ name?: string } | string>);

  if (!issueLabels.includes(LABEL_AVAILABLE)) {
    if (issue.state === 'open' && issue.assignee?.login === username && issueLabels.includes(LABEL_CLAIMED)) return;
    throw new Error(`Task #${number} is not available to claim (current status: ${currentStatus}).`);
  }
  if (issue.assignee?.login && issue.assignee.login !== username) {
    throw new Error(`Task #${number} is already assigned to @${issue.assignee.login}.`);
  }

  await acquireClaimLock(octokit, owner, repo, number, username);
  const latest = (await octokit.issues.get({ owner, repo, issue_number: number })).data;
  const latestStatus = getTaskStatusFromLabels(latest.labels);
  if (latest.state !== 'open' || (latest.assignee?.login && latest.assignee.login !== username)
    || (latestStatus !== 'available' && !(latestStatus === 'claimed' && latest.assignee?.login === username))) {
    throw new Error(`Task #${number} changed while claiming; refresh before continuing.`);
  }
  await octokit.issues.update({
    owner,
    repo,
    issue_number: number,
    assignees: [username],
    labels: [...getIssueLabels(latest.labels).filter(label => !techunterTaskLabels.has(label)), LABEL_CLAIMED],
  });
}

export function formatGuideAsMarkdown(guide: TaskGuide, issueNumber: number): string {
  const lines: string[] = [
    `## Task Guide — #${issueNumber}`,
    '',
    `> ${guide.summary}`,
    '',
  ];

  if (guide.acceptanceCriteria.length > 0) {
    lines.push('### Must Deliver');
    for (const item of guide.acceptanceCriteria) lines.push(`- [ ] ${item}`);
    lines.push('');
  }

  if (guide.filesToModify.length > 0) {
    lines.push('### Files');
    for (const file of guide.filesToModify) lines.push(`- \`${file}\``);
    lines.push('');
  }

  if (guide.suggestedSteps.length > 0) {
    lines.push('<details><summary>Implementation steps</summary>');
    lines.push('');
    guide.suggestedSteps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    lines.push('</details>');
    lines.push('');
  }

  if (guide.optionalImprovements.length > 0) {
    lines.push('### Optional Improvements');
    for (const item of guide.optionalImprovements) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('*Generated by Techunter*');

  return lines.join('\n');
}

export async function postComment(
  config: TechunterConfig,
  number: number,
  body: string
): Promise<void> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;
  await octokit.issues.createComment({ owner, repo, issue_number: number, body });
}

export async function postGuideComment(
  config: TechunterConfig,
  number: number,
  guide: TaskGuide
): Promise<void> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  const body = formatGuideAsMarkdown(guide, number);

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: number,
    body,
  });
}

export async function ensureRemoteBranch(
  config: TechunterConfig,
  branchName: string,
  fallbackBase: string
): Promise<void> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  try {
    await octokit.repos.getBranch({ owner, repo, branch: branchName });
    return; // already exists
  } catch (err: unknown) {
    if ((err as { status?: number }).status !== 404) throw err;
  }

  // Branch doesn't exist — create it from fallbackBase
  const { data: baseRef } = await octokit.repos.getBranch({ owner, repo, branch: fallbackBase });
  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: baseRef.commit.sha,
  });
}

export async function createPR(
  config: TechunterConfig,
  title: string,
  body: string,
  branch: string,
  base: string
): Promise<string> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  const { data } = await octokit.pulls.create({
    owner,
    repo,
    title,
    body,
    head: branch,
    base,
  });

  return data.html_url;
}

export async function markInReview(
  config: TechunterConfig,
  number: number
): Promise<void> {
  if (isCentralTask(await getTask(config, number))) throw new Error('中央任务必须通过中央 API 提交交付包。');
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  for (const label of [LABEL_CLAIMED, LABEL_CHANGES_NEEDED]) {
    try {
      await octokit.issues.removeLabel({ owner, repo, issue_number: number, name: label });
    } catch {
      // Label might not exist
    }
  }

  await octokit.issues.addLabels({
    owner,
    repo,
    issue_number: number,
    labels: [LABEL_IN_REVIEW],
  });
}

export async function closeTask(config: TechunterConfig, number: number): Promise<void> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  const { data: issue } = await octokit.issues.get({ owner, repo, issue_number: number });
  if (isCentralTask({ body: issue.body ?? null })) {
    const { client, task } = await centralTask(config, { body: issue.body ?? null, number });
    await client.request(`/api/tasks/${task.id}`, 'DELETE');
    return;
  }
  const techunterLabels = (issue.labels as Array<{ name?: string }>)
    .map((l) => l.name ?? '')
    .filter((label) => techunterTaskLabels.has(label));

  await octokit.issues.update({ owner, repo, issue_number: number, state: 'closed' });

  for (const label of techunterLabels) {
    await octokit.issues.removeLabel({ owner, repo, issue_number: number, name: label });
  }
  await octokit.git.deleteRef({ owner, repo, ref: claimLockRef(number) }).catch(() => undefined);
}

export interface IssueComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export async function listComments(
  config: TechunterConfig,
  number: number,
  limit = 5
): Promise<IssueComment[]> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  const { data } = await octokit.issues.listComments({
    owner,
    repo,
    issue_number: number,
    per_page: 100,
  });

  return data.slice(-limit).map((c) => ({
    id: c.id,
    author: c.user?.login ?? 'unknown',
    body: c.body ?? '',
    createdAt: c.created_at,
  }));
}

export async function getAuthenticatedUser(config: TechunterConfig): Promise<string> {
  const octokit = createOctokit(config.githubToken);
  const { data } = await octokit.users.getAuthenticated();
  return data.login;
}

export async function isCollaborator(config: TechunterConfig, username: string): Promise<boolean> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;
  try {
    const { data } = await octokit.repos.getCollaboratorPermissionLevel({ owner, repo, username });
    return data.permission === 'admin' || data.permission === 'write' || data.permission === 'maintain';
  } catch {
    return false;
  }
}

export async function listMyTasks(
  config: TechunterConfig,
  username: string
): Promise<GitHubIssue[]> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  const data = await octokit.paginate(octokit.issues.listForRepo, {
    owner,
    repo,
    assignee: username,
    state: 'open',
    per_page: 100,
  });

  return data
    .filter((issue) =>
      (issue.labels as Array<{ name?: string }>).some(
        (l) => l.name === LABEL_CLAIMED || l.name === LABEL_IN_REVIEW || l.name === LABEL_CHANGES_NEEDED
      )
    )
    .map(parseIssue);
}

export async function listTasksForReview(
  config: TechunterConfig,
  username: string
): Promise<GitHubIssue[]> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  const data = await octokit.paginate(octokit.issues.listForRepo, {
    owner,
    repo,
    labels: LABEL_IN_REVIEW,
    state: 'open',
    per_page: 100,
  });

  return data.map(parseIssue).filter(issue => issue.author === username || (isCentralTask(issue) && issue.assignee !== username)).sort((a, b) => a.number - b.number);
}

export async function rejectTask(config: TechunterConfig, number: number, reason = '请根据审核意见修改后重新交付。'): Promise<void> {
  const issue = await getTask(config, number);
  if (isCentralTask(issue)) { await rejectCentralTask(config, issue, reason); return; }
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  try {
    await octokit.issues.removeLabel({
      owner,
      repo,
      issue_number: number,
      name: LABEL_IN_REVIEW,
    });
  } catch {
    // Label might not exist
  }

  await octokit.issues.addLabels({
    owner,
    repo,
    issue_number: number,
    labels: [LABEL_CHANGES_NEEDED],
  });
}

export async function ensureLabels(config: TechunterConfig): Promise<void> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  const existing = await octokit.paginate(octokit.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
  const existingNames = new Set(existing.map((l) => l.name));

  await Promise.all(
    LABELS
      .filter((label) => !existingNames.has(label.name))
      .map((label) =>
        octokit.issues.createLabel({ owner, repo, name: label.name, color: label.color, description: label.description })
          .catch(() => {}),
      ),
  );
}

export async function editTask(
  config: TechunterConfig,
  number: number,
  title: string,
  body: string
): Promise<void> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;
  const { data: issue } = await octokit.issues.get({ owner, repo, issue_number: number });
  if (isCentralTask({ body: issue.body ?? null })) throw new Error('中央任务的规格和范围由 API 管理，请在 Desktop 中申请范围复议。');
  const finalBody = withTaskMetadata({
    body,
    baseCommit: extractBaseCommit(issue.body ?? null),
    targetBranch: extractTargetBranch(issue.body ?? null),
  });
  await octokit.issues.update({ owner, repo, issue_number: number, title, body: finalBody });
}

export async function upsertRepoFile(
  config: TechunterConfig,
  filePath: string,
  content: string,
  message: string,
): Promise<string> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  let sha: string | undefined;
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: filePath });
    if (!Array.isArray(data) && data.type === 'file') {
      sha = data.sha;
    }
  } catch {
    // File does not exist yet — will be created
  }

  const { data } = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    ...(sha ? { sha } : {}),
  });

  return data.content?.html_url ?? `https://github.com/${owner}/${repo}/blob/main/${filePath}`;
}

export async function getRepoFile(config: TechunterConfig, filePath: string): Promise<string | null> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: filePath });
    if (!Array.isArray(data) && data.type === 'file' && 'content' in data) {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return null;
  } catch {
    return null;
  }
}

export async function getDefaultBranch(config: TechunterConfig): Promise<string> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;
  const { data } = await octokit.repos.get({ owner, repo });
  return data.default_branch;
}

export async function getTaskBranch(config: TechunterConfig, issueNumber: number): Promise<string | null> {
  const issue = await getTask(config, issueNumber);
  const prs = await listOpenPullRequests(config);
  const expectedBranch = issue.assignee ? makeTaskBranchName(issueNumber, issue.assignee) : null;

  if (expectedBranch) {
    const matchingPR = prs.find((pr) => pr.head.ref === expectedBranch && issueBodyClosesTask(pr.body, issueNumber));
    if (matchingPR) return matchingPR.head.ref;
  }

  const matchingPR = prs.find((pr) => issueBodyClosesTask(pr.body, issueNumber));
  if (matchingPR) return matchingPR.head.ref;

  const branches = await listRepoBranches(config);
  if (expectedBranch && branches.some((branch) => branch.name === expectedBranch)) {
    return expectedBranch;
  }

  const taskBranch = branches.find((branch) => new RegExp(`^task-${issueNumber}-`).test(branch.name));
  return taskBranch?.name ?? null;
}

export async function getBranchHeadSha(config: TechunterConfig, branchName: string): Promise<string | null> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;
  try {
    const { data } = await octokit.repos.getBranch({ owner, repo, branch: branchName });
    return data.commit.sha;
  } catch {
    return null;
  }
}

export async function moveTask(
  config: TechunterConfig,
  issueNumber: number,
  newTargetBranch: string,
  newBaseCommit: string
): Promise<void> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;
  const { data } = await octokit.issues.get({ owner, repo, issue_number: issueNumber });
  if (isCentralTask({ body: data.body ?? null })) throw new Error('中央任务的来源版本和目标分支已经冻结，不能移动。');
  const parentNumber = newTargetBranch.match(/^task-(\d+)-/)?.[1];
  if (parentNumber && isCentralTask(await getTask(config, Number(parentNumber)))) throw new Error('不能把独立 GitHub 任务移动到中央任务下，请通过 Desktop 创建受预算和范围约束的子任务。');
  const body = withTaskMetadata({ body: data.body ?? '', baseCommit: newBaseCommit, targetBranch: newTargetBranch });
  await octokit.issues.update({ owner, repo, issue_number: issueNumber, body });
}


export async function getTaskPR(
  config: TechunterConfig,
  issueNumber: number,
  headBranch?: string
): Promise<{ number: number; url: string; body: string; baseBranch: string; headBranch: string } | null> {
  const prs = await listOpenPullRequests(config);
  const pr = prs.find((candidate) =>
    issueBodyClosesTask(candidate.body, issueNumber) &&
    (!headBranch || candidate.head.ref === headBranch)
  );
  if (!pr) return null;
  return {
    number: pr.number,
    url: pr.html_url,
    body: pr.body ?? '',
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
  };
}

export async function getOpenSubtasks(
  config: TechunterConfig,
  targetBranch: string
): Promise<number[]> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;
  const data = await octokit.paginate(octokit.issues.listForRepo, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });
  return data
    .filter((issue) => !issue.pull_request)
    .filter((issue) => extractTargetBranch(issue.body ?? null) === targetBranch)
    .map((issue) => issue.number);
}

export async function getIssueNumberFromBranch(
  config: TechunterConfig,
  branch: string
): Promise<{ issueNumber: number; prUrl: string } | null> {
  const prs = await listOpenPullRequests(config);
  const pr = prs.find((candidate) => candidate.head.ref === branch);
  if (!pr) return null;
  const match = (pr.body ?? '').match(/Closes #(\d+)/i);
  if (!match) return null;
  return { issueNumber: parseInt(match[1], 10), prUrl: pr.html_url };
}

export async function getTaskPRDiff(
  config: TechunterConfig,
  prNumber: number
): Promise<string> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: 'diff' },
  });
  return response.data as unknown as string;
}

export async function acceptTask(
  config: TechunterConfig,
  issueNumber: number
): Promise<{ prNumber: number; prUrl: string; sha: string; baseBranch: string }> {
  const issue = await getTask(config, issueNumber);
  if (isCentralTask(issue)) {
    const task = await acceptCentralTask(config, issue);
    const url = task.latestSubmission?.pullRequestUrl ?? '';
    return { prNumber: Number(url.match(/\/pull\/(\d+)/)?.[1]), prUrl: url, sha: '', baseBranch: task.targetBranch };
  }
  const expectedHeadBranch = issue.assignee ? makeTaskBranchName(issueNumber, issue.assignee) : undefined;
  const pr = await getTaskPR(config, issueNumber, expectedHeadBranch);
  if (!pr) {
    throw new Error(
      expectedHeadBranch
        ? `No open PR found for task #${issueNumber} from branch ${expectedHeadBranch}.`
        : `No open PR found for task #${issueNumber}.`
    );
  }

  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  try {
    const { data: merge } = await octokit.pulls.merge({
      owner,
      repo,
      pull_number: pr.number,
      merge_method: 'merge',
    });
    await closeTask(config, issueNumber);
    return { prNumber: pr.number, prUrl: pr.url, sha: merge.sha ?? '', baseBranch: pr.baseBranch };
  } catch (err: unknown) {
    if ((err as { status?: number }).status === 405) {
      throw new Error(
        `PR #${pr.number} cannot be merged — may have conflicts or is not in a mergeable state.`
      );
    }
    throw err;
  }
}
