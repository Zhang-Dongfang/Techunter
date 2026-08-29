import { BookOpenText, BrainCircuit, Coins, ExternalLink, FileText, Github } from 'lucide-react';

import type { Task } from '@techunter/core';

const confidenceLabels = { low: '低置信度', medium: '中置信度', high: '高置信度' } as const;

export function TaskDocument({ task }: { task: Task }) {
  const analysis = task.analysis;

  return <section className="task-document">
    <div className="document-heading">
      <div className="document-icon"><BookOpenText size={20} /></div>
      <div><span className="eyebrow">HUNT BRIEF</span><h3>接任务文档</h3><p>认领前请确认目标、边界、估价依据和交付要求。</p></div>
      <div className="document-badges">
        <span><Coins size={13} />{task.rewardPoints} CP</span>
        {analysis && <span className={`confidence-${analysis.confidence}`}><BrainCircuit size={13} />{confidenceLabels[analysis.confidence]}</span>}
      </div>
    </div>

    <article className="document-goal">
      <span><FileText size={15} />任务目标</span>
      <p>{task.summary || task.description}</p>
    </article>

    <article className="document-analysis"><h4>Agent 分析与估价依据</h4><p>{analysis?.rationale ?? '该任务尚未保存完整 Agent 分析；请以任务目标和验收标准为准。'}</p></article>

    <div className="document-footer">
      <span>建议贡献点 <strong>{analysis?.suggestedPoints ?? task.rewardPoints} CP</strong></span>
      <span>当前目标分支 <code>{task.targetBranch}</code></span>
      {task.githubIssueUrl && <a href={task.githubIssueUrl} target="_blank" rel="noreferrer"><Github size={14} />GitHub Issue #{task.githubIssueNumber}<ExternalLink size={12} /></a>}
    </div>
  </section>;
}
