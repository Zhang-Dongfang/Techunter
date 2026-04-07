import { Octokit } from '@octokit/rest';
import type { TechunterConfig, GitHubIssue, TaskGuide } from '../types.js';
import { fetch as undiciFetch } from 'undici';
import { getHttpsProxyAgent, getUndiciProxyAgent } from './proxy.js';

const LABEL_AVAILABLE = 'techunter:available';
const LABEL_CLAIMED = 'techunter:claimed';
const LABEL_IN_REVIEW = 'techunter:in-review';
const LABEL_CHANGES_NEEDED = 'techunter:changes-needed';

const LABELS = [
  { name: LABEL_AVAILABLE, color: '0e8a16', description: 'Task available to claim' },
  { name: LABEL_CLAIMED, color: 'e4a000', description: 'Task claimed by a developer' },
  { name: LABEL_IN_REVIEW, color: '0075ca', description: 'Task submitted for review' },
  { name: LABEL_CHANGES_NEEDED, color: 'e11d48', description: 'Task needs changes' },
];

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

const TECHUNTER_LABELS = new Set([LABEL_AVAILABLE, LABEL_CLAIMED, LABEL_IN_REVIEW, LABEL_CHANGES_NEEDED]);

export async function listTasks(config: TechunterConfig): Promise<GitHubIssue[]> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  const { data } = await octokit.issues.listForRepo({
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });

  return data
    .filter((issue) =>
      !issue.pull_request &&
      (issue.labels as Array<{ name?: string }>).some((l) => TECHUNTER_LABELS.has(l.name ?? ''))
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

const BASE_COMMIT_MARKER = '<!-- techunter-base:';
const TARGET_BRANCH_MARKER = '<!-- techunter-target:';

export function embedBaseCommit(body: string, sha: string): string {
  return `${body}\n\n${BASE_COMMIT_MARKER}${sha} -->`;
}

export function extractBaseCommit(body: string | null): string | null {
  if (!body) return null;
  const match = body.match(/<!-- techunter-base:([a-f0-9]{7,40}) -->/);
  return match?.[1] ?? null;
}

export function embedTargetBranch(body: string, branch: string): string {
  return `${body}\n${TARGET_BRANCH_MARKER}${branch} -->`;
}

export function extractTargetBranch(body: string | null): string | null {
  if (!body) return null;
  const match = body.match(/<!-- techunter-target:([^\s>]+) -->/);
  return match?.[1] ?? null;
}

export async function createTask(
  config: TechunterConfig,
  title: string,
  body?: string,
  baseCommit?: string,
  targetBranch?: string
): Promise<GitHubIssue> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  await ensureLabels(config);

  let finalBody = body ?? '';
  if (baseCommit) finalBody = embedBaseCommit(finalBody, baseCommit);
  if (targetBranch) finalBody = embedTargetBranch(finalBody, targetBranch);

  const { data } = await octokit.issues.create({
    owner,
    repo,
    title,
    body: finalBody,
    labels: [LABEL_AVAILABLE],
  });

  return parseIssue(data);
}

export async function mergeWorkerIntoBase(
  config: TechunterConfig,
  workerBranch: string,
  baseBranch: string
): Promise<void> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;
  try {
    await octokit.repos.merge({
      owner,
      repo,
      base: baseBranch,
      head: workerBranch,
      commit_message: `chore: merge ${workerBranch} into ${baseBranch}`,
    });
  } catch (err: unknown) {
    if ((err as { status?: number }).status === 409) {
      throw new Error(
        `Merge conflict: ${workerBranch} cannot be merged into ${baseBranch} cleanly. Resolve conflicts manually.`
      );
    }
    throw err;
  }
}

export async function claimTask(
  config: TechunterConfig,
  number: number,
  username: string
): Promise<void> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  await octokit.issues.update({
    owner,
    repo,
    issue_number: number,
    assignees: [username],
  });

  // Remove available label, add claimed label
  try {
    await octokit.issues.removeLabel({
      owner,
      repo,
      issue_number: number,
      name: LABEL_AVAILABLE,
    });
  } catch {
    // Label might not exist, that's fine
  }

  await octokit.issues.addLabels({
    owner,
    repo,
    issue_number: number,
    labels: [LABEL_CLAIMED],
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
  const techunterLabels = (issue.labels as Array<{ name?: string }>)
    .map((l) => l.name ?? '')
    .filter((l) => [LABEL_AVAILABLE, LABEL_CLAIMED, LABEL_IN_REVIEW, LABEL_CHANGES_NEEDED].includes(l));

  await octokit.issues.update({ owner, repo, issue_number: number, state: 'closed' });

  for (const label of techunterLabels) {
    await octokit.issues.removeLabel({ owner, repo, issue_number: number, name: label });
  }
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

  const { data } = await octokit.issues.listForRepo({
    owner,
    repo,
    assignee: username,
    state: 'open',
    per_page: 50,
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

  const { data } = await octokit.issues.listForRepo({
    owner,
    repo,
    creator: username,
    labels: LABEL_IN_REVIEW,
    state: 'open',
    per_page: 50,
  });

  return data.map(parseIssue).sort((a, b) => a.number - b.number);
}

export async function rejectTask(config: TechunterConfig, number: number): Promise<void> {
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

  const { data: existing } = await octokit.issues.listLabelsForRepo({ owner, repo, per_page: 100 });
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
  await octokit.issues.update({ owner, repo, issue_number: number, title, body });
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
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;
  // First try open PRs
  const { data: prs } = await octokit.pulls.list({ owner, repo, state: 'open', per_page: 100 });
  const pr = prs.find((p) => new RegExp(`Closes #${issueNumber}\\b`, 'i').test(p.body ?? ''));
  if (pr) return pr.head.ref;
  // Fall back to remote branches matching task-{issueNumber}-*
  const { data: branches } = await octokit.repos.listBranches({ owner, repo, per_page: 100 });
  const taskBranch = branches.find((b) => new RegExp(`^task-${issueNumber}-`).test(b.name));
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
  let body = data.body ?? '';
  // Strip existing markers, then re-embed updated values
  body = body.replace(/\n*<!-- techunter-base:[a-f0-9]{7,40} -->/g, '');
  body = body.replace(/\n*<!-- techunter-target:[^\s>]+ -->/g, '');
  body = embedBaseCommit(body, newBaseCommit);
  body = embedTargetBranch(body, newTargetBranch);
  await octokit.issues.update({ owner, repo, issue_number: issueNumber, body });
}


export async function getTaskPR(
  config: TechunterConfig,
  issueNumber: number
): Promise<{ number: number; url: string; body: string; baseBranch: string } | null> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;
  const { data: prs } = await octokit.pulls.list({ owner, repo, state: 'open', per_page: 100 });
  const pr = prs.find((p) =>
    new RegExp(`Closes #${issueNumber}\\b`, 'i').test(p.body ?? '')
  );
  if (!pr) return null;
  return { number: pr.number, url: pr.html_url, body: pr.body ?? '', baseBranch: pr.base.ref };
}

export async function getOpenSubtasks(
  config: TechunterConfig,
  targetBranch: string
): Promise<number[]> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;
  const { data } = await octokit.issues.listForRepo({
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
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;
  const { data: prs } = await octokit.pulls.list({ owner, repo, state: 'open', per_page: 100 });
  const pr = prs.find((p) => p.head.ref === branch);
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
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  const { data: prs } = await octokit.pulls.list({ owner, repo, state: 'open', per_page: 100 });
  const pr = prs.find((p) =>
    new RegExp(`Closes #${issueNumber}\\b`, 'i').test(p.body ?? '')
  );
  if (!pr) throw new Error(`No open PR found for task #${issueNumber}`);

  try {
    const { data: merge } = await octokit.pulls.merge({
      owner,
      repo,
      pull_number: pr.number,
      merge_method: 'merge',
    });
    await closeTask(config, issueNumber);
    return { prNumber: pr.number, prUrl: pr.html_url, sha: merge.sha ?? '', baseBranch: pr.base.ref };
  } catch (err: unknown) {
    if ((err as { status?: number }).status === 405) {
      throw new Error(
        `PR #${pr.number} cannot be merged — may have conflicts or is not in a mergeable state.`
      );
    }
    throw err;
  }
}
