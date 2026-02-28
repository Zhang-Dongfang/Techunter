import chalk from 'chalk';
import ora from 'ora';
import { getConfig } from '../lib/config.js';
import {
  getTask,
  claimTask,
  postGuideComment,
  getAuthenticatedUser,
  formatGuideAsMarkdown,
} from '../lib/github.js';
import { buildProjectContext } from '../lib/project.js';
import { generateGuide } from '../lib/ai.js';
import { createAndSwitchBranch, pushBranch, makeBranchName, getCurrentRepoRoot } from '../lib/git.js';
import type { TaskGuide } from '../types.js';

function printGuide(guide: TaskGuide, issueNumber: number): void {
  console.log('\n' + chalk.bold.cyan(`Task Guide — Issue #${issueNumber}`));
  console.log(chalk.dim('─'.repeat(60)));

  console.log(chalk.bold('\nSummary:'));
  console.log('  ' + guide.summary);

  console.log(chalk.bold('\nContext:'));
  console.log('  ' + guide.context);

  if (guide.prerequisites.length > 0) {
    console.log(chalk.bold('\nPrerequisites:'));
    for (const item of guide.prerequisites) console.log(`  • ${item}`);
  }

  if (guide.inputs.length > 0) {
    console.log(chalk.bold('\nInputs:'));
    for (const item of guide.inputs) console.log(`  • ${item}`);
  }

  if (guide.outputs.length > 0) {
    console.log(chalk.bold('\nOutputs:'));
    for (const item of guide.outputs) console.log(`  • ${item}`);
  }

  if (guide.acceptanceCriteria.length > 0) {
    console.log(chalk.bold('\nAcceptance Criteria:'));
    for (const item of guide.acceptanceCriteria) console.log(`  ☐ ${item}`);
  }

  if (guide.suggestedSteps.length > 0) {
    console.log(chalk.bold('\nSuggested Steps:'));
    guide.suggestedSteps.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
  }

  if (guide.filesToModify.length > 0) {
    console.log(chalk.bold('\nFiles to Modify:'));
    for (const f of guide.filesToModify) console.log('  ' + chalk.yellow(f));
  }

  console.log(chalk.dim('\n' + '─'.repeat(60)));
}

export async function claimCommand(issueNumberStr: string): Promise<void> {
  const issueNumber = parseInt(issueNumberStr, 10);
  if (isNaN(issueNumber) || issueNumber <= 0) {
    console.error(chalk.red('Error: issue number must be a positive integer'));
    process.exit(1);
  }

  const config = getConfig();

  // Fetch issue
  let spinner = ora(`Fetching issue #${issueNumber}...`).start();
  let issue;
  let me: string;

  try {
    [issue, me] = await Promise.all([
      getTask(config, issueNumber),
      getAuthenticatedUser(config),
    ]);
    spinner.succeed(`Issue #${issueNumber}: ${issue.title}`);
  } catch (err) {
    spinner.fail('Failed to fetch issue');
    throw err;
  }

  // Check not already claimed by someone else
  if (
    issue.assignee &&
    issue.assignee !== me &&
    issue.labels.includes('techunter:claimed')
  ) {
    console.error(
      chalk.red(
        `Error: Issue #${issueNumber} is already claimed by ${issue.assignee}`
      )
    );
    process.exit(1);
  }

  // Build project context
  spinner = ora('Reading project files...').start();
  let projectContext;

  try {
    const cwd = await getCurrentRepoRoot().catch(() => process.cwd());
    projectContext = await buildProjectContext(cwd, issue.title, issue.body ?? '');
    spinner.succeed(`Read ${Object.keys(projectContext.keyFiles).length} key files`);
  } catch (err) {
    spinner.fail('Failed to read project files');
    throw err;
  }

  // Generate guide with GLM
  spinner = ora('Generating task guide with GLM...').start();
  let guide: TaskGuide;

  try {
    guide = await generateGuide(
      config.aiApiKey,
      projectContext,
      issueNumber,
      issue.title,
      issue.body ?? ''
    );
    spinner.succeed('Task guide generated');
  } catch (err) {
    spinner.fail('Failed to generate guide');
    throw err;
  }

  // Post guide as comment
  spinner = ora('Posting guide to GitHub...').start();
  try {
    await postGuideComment(config, issueNumber, guide);
    spinner.succeed('Guide posted as issue comment');
  } catch (err) {
    spinner.fail('Failed to post guide comment');
    throw err;
  }

  // Claim the task
  spinner = ora('Claiming task...').start();
  try {
    await claimTask(config, issueNumber, me);
    spinner.succeed(`Issue #${issueNumber} claimed by @${me}`);
  } catch (err) {
    spinner.fail('Failed to claim task');
    throw err;
  }

  // Create branch
  const branchName = makeBranchName(issueNumber, issue.title);
  spinner = ora(`Creating branch: ${branchName}...`).start();
  try {
    await createAndSwitchBranch(branchName);
    spinner.succeed(`Switched to branch: ${chalk.cyan(branchName)}`);
  } catch (err) {
    spinner.fail('Failed to create branch');
    console.error(chalk.dim(String(err)));
    // Don't exit — branch creation is nice-to-have, guide is the main value
  }

  // Push branch
  spinner = ora('Pushing branch to origin...').start();
  try {
    await pushBranch(branchName);
    spinner.succeed('Branch pushed');
  } catch (err) {
    spinner.stop();
    console.log(chalk.dim(`Note: Could not push branch (${(err as Error).message})`));
  }

  // Display guide
  printGuide(guide, issueNumber);

  console.log(chalk.green.bold('\nTask claimed successfully!'));
  console.log(chalk.dim(`Branch: ${branchName}`));
  console.log(chalk.dim(`Issue: ${issue.htmlUrl}`));
  console.log(chalk.dim('\nWhen done, run: tch deliver\n'));
}
