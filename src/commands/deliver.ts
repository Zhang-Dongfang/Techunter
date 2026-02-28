import chalk from 'chalk';
import ora from 'ora';
import { getConfig } from '../lib/config.js';
import { getTask, createPR, markInReview, getDefaultBranch } from '../lib/github.js';
import { getCurrentBranch, pushBranch } from '../lib/git.js';

function parseIssueNumberFromBranch(branch: string): number | null {
  // Expected format: task-{number}-{kebab-title}
  const match = branch.match(/^task-(\d+)/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

export async function deliverCommand(): Promise<void> {
  const config = getConfig();

  // Detect current branch
  let branch: string;
  try {
    branch = await getCurrentBranch();
  } catch (err) {
    console.error(chalk.red('Error: Could not determine current branch'));
    throw err;
  }

  const issueNumber = parseIssueNumberFromBranch(branch);
  if (!issueNumber) {
    console.error(
      chalk.red(
        `Error: Current branch "${branch}" does not follow the task-{N}-* naming convention.\n` +
        'Use `tch claim <n>` to create a properly named branch.'
      )
    );
    process.exit(1);
  }

  console.log(chalk.dim(`Branch: ${branch}`));
  console.log(chalk.dim(`Issue: #${issueNumber}`));

  // Fetch issue details
  let spinner = ora(`Fetching issue #${issueNumber}...`).start();
  let issue;

  try {
    issue = await getTask(config, issueNumber);
    spinner.succeed(`Issue: ${issue.title}`);
  } catch (err) {
    spinner.fail('Failed to fetch issue');
    throw err;
  }

  // Push latest commits
  spinner = ora('Pushing latest commits...').start();
  try {
    await pushBranch(branch);
    spinner.succeed('Branch pushed');
  } catch (err) {
    spinner.fail('Failed to push branch');
    throw err;
  }

  // Get default branch for PR base
  let defaultBranch = 'main';
  try {
    defaultBranch = await getDefaultBranch(config);
  } catch {
    // Fall back to 'main'
  }

  // Create PR
  spinner = ora('Creating pull request...').start();
  let prUrl: string;

  try {
    const prTitle = issue.title;
    const prBody = [
      `Closes #${issueNumber}`,
      '',
      `## Summary`,
      '',
      `This PR implements the task described in issue #${issueNumber}: **${issue.title}**`,
      '',
      '---',
      '*Created with [Techunter](https://github.com/techunter-cli)*',
    ].join('\n');

    prUrl = await createPR(config, prTitle, prBody, branch, defaultBranch);
    spinner.succeed('Pull request created');
  } catch (err) {
    spinner.fail('Failed to create pull request');
    throw err;
  }

  // Mark issue as in-review
  spinner = ora('Updating issue labels...').start();
  try {
    await markInReview(config, issueNumber);
    spinner.succeed(`Issue #${issueNumber} marked as in-review`);
  } catch (err) {
    spinner.stop();
    console.log(chalk.dim('Note: Could not update issue labels'));
  }

  console.log(chalk.green.bold('\nDelivery complete!'));
  console.log(chalk.cyan(`  PR: ${prUrl}`));
  console.log(chalk.dim(`  Issue: ${issue.htmlUrl}\n`));
}
