export function formatCleanupSuggestions(
  taskBranch: string,
  workerBranch: string,
  workerMergedToBase: boolean,
): string {
  const lines = [
    '分支清理建议：',
    '```bash',
    `git push origin --delete ${taskBranch}`,
    `git branch -d ${taskBranch}`,
  ];

  if (workerMergedToBase) {
    lines.push(`# 若所有任务已完成，也可清理 worker 分支：`);
    lines.push(`git push origin --delete ${workerBranch}`);
    lines.push(`git branch -d ${workerBranch}`);
  }

  lines.push('```');
  return lines.join('\n');
}
