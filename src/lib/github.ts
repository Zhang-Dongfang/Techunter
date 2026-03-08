import { Octokit } from '@octokit/rest';
import type { TechunterConfig, GitHubIssue, TaskGuide } from '../types.js';

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
  return new Octokit({
    auth: token,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
}

function parseIssue(issue: {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  assignee?: { login: string } | null;
  labels?: Array<{ name?: string } | string>;
  html_url: string;
}): GitHubIssue {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    state: issue.state,
    assignee: issue.assignee?.login ?? null,
    labels: (issue.labels ?? []).map((l) =>
      typeof l === 'string' ? l : (l.name ?? '')
    ),
    htmlUrl: issue.html_url,
  };
}

export async function listTasks(config: TechunterConfig): Promise<GitHubIssue[]> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  const [available, claimed, inReview, changesNeeded] = await Promise.all([
    octokit.issues.listForRepo({
      owner,
      repo,
      labels: LABEL_AVAILABLE,
      state: 'open',
      per_page: 50,
    }),
    octokit.issues.listForRepo({
      owner,
      repo,
      labels: LABEL_CLAIMED,
      state: 'open',
      per_page: 50,
    }),
    octokit.issues.listForRepo({
      owner,
      repo,
      labels: LABEL_IN_REVIEW,
      state: 'open',
      per_page: 50,
    }),
    octokit.issues.listForRepo({
      owner,
      repo,
      labels: LABEL_CHANGES_NEEDED,
      state: 'open',
      per_page: 50,
    }),
  ]);

  const allIssues = [...available.data, ...claimed.data, ...inReview.data, ...changesNeeded.data];
  // Deduplicate by number
  const seen = new Set<number>();
  const unique: GitHubIssue[] = [];
  for (const issue of allIssues) {
    if (!seen.has(issue.number)) {
      seen.add(issue.number);
      unique.push(parseIssue(issue));
    }
  }

  return unique.sort((a, b) => a.number - b.number);
}

export async function getTask(config: TechunterConfig, number: number): Promise<GitHubIssue> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  const { data } = await octokit.issues.get({ owner, repo, issue_number: number });
  return parseIssue(data);
}

export async function createTask(
  config: TechunterConfig,
  title: string,
  body?: string
): Promise<GitHubIssue> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  await ensureLabels(config);

  const { data } = await octokit.issues.create({
    owner,
    repo,
    title,
    body,
    labels: [LABEL_AVAILABLE],
  });

  return parseIssue(data);
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

  try {
    await octokit.issues.removeLabel({
      owner,
      repo,
      issue_number: number,
      name: LABEL_CLAIMED,
    });
  } catch {
    // Label might not exist
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

export async function getDefaultBranch(config: TechunterConfig): Promise<string> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;
  const { data } = await octokit.repos.get({ owner, repo });
  return data.default_branch;
}

export function getBaseBranch(config: TechunterConfig): Promise<string> {
  if (config.github.baseBranch) return Promise.resolve(config.github.baseBranch);
  return getDefaultBranch(config);
}

export async function acceptTask(
  config: TechunterConfig,
  issueNumber: number
): Promise<{ prNumber: number; prUrl: string; sha: string }> {
  const octokit = createOctokit(config.githubToken);
  const { owner, repo } = config.github;

  // Find open PR whose head branch matches task-{number}-*
  const { data: prs } = await octokit.pulls.list({ owner, repo, state: 'open', per_page: 100 });
  const pr = prs.find((p) => p.head.ref.startsWith(`task-${issueNumber}-`));
  if (!pr) throw new Error(`No open PR found for task #${issueNumber} (expected branch starting with task-${issueNumber}-)`);

  // Merge PR
  const { data: merge } = await octokit.pulls.merge({
    owner,
    repo,
    pull_number: pr.number,
    merge_method: 'merge',
  });

  // Close issue
  await closeTask(config, issueNumber);

  return { prNumber: pr.number, prUrl: pr.html_url, sha: merge.sha ?? '' };
}
