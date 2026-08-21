import { minimatch } from 'minimatch';

import { runAgentLoop } from './agent-runtime.js';
import { createRepositoryTools, listRepositoryFiles, repositoryDefaultDeniedPatterns } from './repository-tools.js';
import type { AgentHooks, AiConfig, DeliveryReview, RepositoryAccess, TaskScope, TaskSpec } from './types.js';

function jsonFromText<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const source = fenced ?? (start >= 0 && end > start ? text.slice(start, end + 1) : text);
  return JSON.parse(source.trim()) as T;
}

function strings(value: unknown, max = 100): string[] {
  return [...new Set(Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [])].slice(0, max);
}

function safePaths(value: unknown): string[] {
  return strings(value).map((item) => item.replaceAll('\\', '/').replace(/^\.\//, ''))
    .filter((item) => item && item !== '..' && !item.startsWith('/') && !item.includes('../'));
}

function matchAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(file, pattern, { dot: true, nocase: process.platform === 'win32' }));
}

async function normalizeScope(raw: Partial<TaskScope> | undefined, repository: RepositoryAccess): Promise<TaskScope> {
  const denied = [...new Set([...repositoryDefaultDeniedPatterns, ...(repository.deniedPatterns ?? []), ...safePaths(raw?.deniedPaths)])];
  let editable = safePaths(raw?.editablePaths).filter((file) => !matchAny(file, denied));
  let readonly = safePaths(raw?.readonlyPaths).filter((file) => !matchAny(file, denied));
  if (repository.editablePatterns || repository.readonlyPatterns) {
    const visibleEditable = await listRepositoryFiles({ ...repository, readonlyPatterns: [] });
    const visibleReadonly = await listRepositoryFiles({ ...repository, editablePatterns: repository.readonlyPatterns, readonlyPatterns: [] });
    editable = visibleEditable.filter((file) => matchAny(file, editable));
    readonly = visibleReadonly.filter((file) => matchAny(file, readonly) && !editable.includes(file));
  }
  if (!editable.length) throw new Error('Agent 没有给出有效的 editablePaths，任务未发布。');
  return {
    revision: 1,
    editablePaths: editable,
    readonlyPaths: readonly.filter((file) => !editable.includes(file)),
    deniedPaths: denied,
    visibleTests: safePaths(raw?.visibleTests),
    environment: {
      setupCommands: strings(raw?.environment?.setupCommands, 10),
      testCommands: strings(raw?.environment?.testCommands, 10),
      networkAllowlist: strings(raw?.environment?.networkAllowlist, 30),
    },
  };
}

export async function analyzeTaskWithAgent(input: {
  config: AiConfig;
  title: string;
  description: string;
  repository: RepositoryAccess;
  feedback?: string;
  previousGuide?: string;
  hooks?: AgentHooks;
}): Promise<TaskSpec> {
  const rawText = await runAgentLoop({
    config: input.config,
    systemPrompt:
      'You are the Techunter task specification Agent used by both the CLI and desktop applications. ' +
      'First use list_files, then grep_code to inspect relevant implementation and test files. ' +
      'Never request or expose .env, credentials, keys, .git, or paths outside the visible repository scope. ' +
      'Return strict JSON only with: summary, acceptanceCriteria (maximum 5), suggestedPoints (integer; effective hours × 10), ' +
      'confidence (low|medium|high), rationale, and scope. scope must contain editablePaths, readonlyPaths, deniedPaths, ' +
      'visibleTests and environment {setupCommands, testCommands, networkAllowlist}. setupCommands must prepare the project on the native host without a prebuilt image. ' +
      'editablePaths must be the smallest concrete set of files required. Reply content must use the task language.',
    userMessage: [
      `Task: ${input.title}`,
      `Description: ${input.description}`,
      input.feedback ? `Revision feedback: ${input.feedback}` : '',
      input.previousGuide ? `Previous guide:\n${input.previousGuide}` : '',
    ].filter(Boolean).join('\n\n'),
    tools: createRepositoryTools(input.repository),
    hooks: input.hooks,
  });
  let raw: Partial<TaskSpec>;
  try { raw = jsonFromText<Partial<TaskSpec>>(rawText); }
  catch (error) { throw new Error(`Task Agent 返回了无效 JSON：${(error as Error).message}`); }
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  const acceptanceCriteria = strings(raw.acceptanceCriteria, 5);
  if (!summary || !acceptanceCriteria.length) throw new Error('Task Agent 返回结果缺少摘要或验收标准。');
  return {
    summary,
    acceptanceCriteria,
    suggestedPoints: Math.max(10, Math.min(100_000, Math.round(Number(raw.suggestedPoints) || 0))),
    confidence: ['low', 'medium', 'high'].includes(String(raw.confidence))
      ? raw.confidence as TaskSpec['confidence']
      : 'low',
    rationale: typeof raw.rationale === 'string' && raw.rationale.trim()
      ? raw.rationale.trim()
      : '由 Techunter Task Agent 根据仓库证据评估。',
    scope: await normalizeScope(raw.scope, input.repository),
  };
}

export async function reviewDeliveryWithAgent(input: {
  config: AiConfig;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  summary: string;
  testOutput: string;
  changedFiles?: Array<{ path: string; content: string | null }>;
  diff?: string;
  repository?: RepositoryAccess;
  hooks?: AgentHooks;
}): Promise<DeliveryReview> {
  const rawText = await runAgentLoop({
    config: input.config,
    systemPrompt:
      'You are the Techunter delivery review Agent used by both the CLI and desktop applications. ' +
      'Judge only against the task acceptance criteria and supplied code/test evidence. Use repository tools only when evidence needs verification. ' +
      'Return strict JSON only: score (0-100), verdict (approved|changes_requested), summary, ' +
      'findings [{criterion, passed, evidence}], risks (string[]), deliveryDocument (Markdown). Reply in the task language.',
    userMessage: JSON.stringify({
      task: { title: input.title, description: input.description, acceptanceCriteria: input.acceptanceCriteria },
      submission: {
        summary: input.summary,
        testOutput: input.testOutput,
        changedFiles: input.changedFiles,
        diff: input.diff,
      },
    }),
    tools: input.repository ? createRepositoryTools(input.repository) : [],
    hooks: input.hooks,
  });
  let raw: Partial<DeliveryReview>;
  try { raw = jsonFromText<Partial<DeliveryReview>>(rawText); }
  catch (error) { throw new Error(`Review Agent 返回了无效 JSON：${(error as Error).message}`); }
  const verdict = raw.verdict === 'approved' ? 'approved' : 'changes_requested';
  const findings = Array.isArray(raw.findings) ? raw.findings.filter((item) =>
    item && typeof item.criterion === 'string' && typeof item.passed === 'boolean' && typeof item.evidence === 'string'
  ) : [];
  if (!findings.length) throw new Error('Review Agent 没有返回验收项证据。');
  return {
    score: Math.max(0, Math.min(100, Math.round(Number(raw.score) || 0))),
    verdict,
    summary: typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : 'Agent 未提供审查摘要。',
    findings,
    risks: strings(raw.risks, 20),
    deliveryDocument: typeof raw.deliveryDocument === 'string' && raw.deliveryDocument.trim()
      ? raw.deliveryDocument.trim()
      : ['# Delivery Review', '', ...findings.map((finding) => `- ${finding.passed ? '✅' : '❌'} ${finding.criterion}: ${finding.evidence}`)].join('\n'),
  };
}

export function renderDeliveryReview(review: DeliveryReview): string {
  return [
    ...review.findings.map((finding) => `${finding.passed ? '✅' : '❌'} ${finding.criterion} — ${finding.evidence}`),
    '',
    review.summary,
    ...(review.risks.length ? ['', 'Risks:', ...review.risks.map((risk) => `- ${risk}`)] : []),
    '',
    review.verdict === 'approved' ? 'Ready to submit' : 'Not ready',
  ].join('\n');
}
