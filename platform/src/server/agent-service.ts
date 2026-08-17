import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { minimatch } from 'minimatch';
import OpenAI from 'openai';
import type { ReviewResult, TaskAnalysis, TaskScope } from '../shared/contracts.js';
import { config } from './config.js';

interface AnalyzeInput {
  title: string;
  description: string;
  repoPath: string | null;
  editableLimit?: string[];
  readonlyLimit?: string[];
  inheritedDeniedPaths?: string[];
}

interface ReviewInput {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  changedFiles: Array<{ path: string; content: string | null }>;
  testOutput: string;
  summary: string;
}

const DEFAULT_DENIED = [
  '.git/**',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/secrets/**',
  '**/node_modules/**',
  '**/dist/**',
];

const CONFIG_FILES = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'Dockerfile',
  '.devcontainer/devcontainer.json',
];

function jsonFromText<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(source.trim()) as T;
}

function normalizeScope(input: Partial<TaskScope> | undefined, inheritedDeniedPaths: string[] = []): TaskScope {
  const unique = (values: unknown): string[] => [...new Set(
    Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : []
  )].map((value) => value.replaceAll('\\', '/').replace(/^\.\//, ''));
  return {
    revision: 1,
    editablePaths: unique(input?.editablePaths),
    readonlyPaths: unique(input?.readonlyPaths),
    deniedPaths: [...new Set([...DEFAULT_DENIED, ...inheritedDeniedPaths, ...unique(input?.deniedPaths)])],
    visibleTests: unique(input?.visibleTests),
    environment: {
      image: input?.environment?.image || 'node:22-bookworm',
      setupCommands: unique(input?.environment?.setupCommands),
      testCommands: unique(input?.environment?.testCommands),
      networkAllowlist: unique(input?.environment?.networkAllowlist),
    },
  };
}

export class AgentService {
  private readonly client = config.ai.apiKey
    ? new OpenAI({ apiKey: config.ai.apiKey, baseURL: config.ai.baseUrl })
    : null;

  async analyze(input: AnalyzeInput): Promise<TaskAnalysis> {
    const inheritedDenied = [...DEFAULT_DENIED, ...(input.inheritedDeniedPaths ?? [])];
    const limited = Boolean(input.editableLimit || input.readonlyLimit);
    const editableFiles = input.repoPath && limited
      ? await fg(input.editableLimit ?? [], {
          cwd: input.repoPath,
          onlyFiles: true,
          dot: true,
          followSymbolicLinks: false,
          ignore: inheritedDenied,
        })
      : [];
    const readonlyFiles = input.repoPath && limited
      ? await fg(input.readonlyLimit ?? [], {
          cwd: input.repoPath,
          onlyFiles: true,
          dot: true,
          followSymbolicLinks: false,
          ignore: inheritedDenied,
        })
      : [];
    const files = input.repoPath
      ? (limited
          ? [...new Set([...editableFiles, ...readonlyFiles])]
          : await fg('**/*', {
              cwd: input.repoPath,
              onlyFiles: true,
              dot: true,
              followSymbolicLinks: false,
              ignore: inheritedDenied,
            }))
        .slice(0, 600)
      : [];

    if (this.client) {
      try {
        const response = await this.client.chat.completions.create({
          model: config.ai.model,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content:
                '你是 Techunter 企业任务规划 Agent。根据需求和文件树生成严格 JSON，不要输出其他内容。' +
                'JSON 字段：summary、acceptanceCriteria(string[])、suggestedPoints(integer)、confidence(low|medium|high)、rationale、' +
                'scope，其中 scope 包含 editablePaths、readonlyPaths、deniedPaths、visibleTests、environment(image,setupCommands,testCommands,networkAllowlist)。' +
                '遵循最小暴露原则，editablePaths 只列必须修改的路径；不得选择密钥、.env 或 .git。贡献点约等于预计有效小时×10。',
            },
            {
              role: 'user',
              content: `任务：${input.title}\n\n说明：${input.description}\n\n仓库文件：\n${files.join('\n')}`,
            },
          ],
        });
        const raw = jsonFromText<Partial<TaskAnalysis>>(response.choices[0]?.message.content ?? '');
        const analysis: TaskAnalysis = {
          summary: raw.summary?.trim() || input.description,
          acceptanceCriteria: (raw.acceptanceCriteria ?? []).filter(Boolean).slice(0, 5),
          suggestedPoints: Math.max(10, Math.min(5000, Math.round(raw.suggestedPoints ?? 80))),
          confidence: raw.confidence ?? 'medium',
          rationale: raw.rationale?.trim() || '根据任务范围和仓库结构估算。',
          scope: normalizeScope(raw.scope, input.inheritedDeniedPaths),
        };
        return limited ? this.constrainToParentScope(analysis, editableFiles, readonlyFiles) : analysis;
      } catch (error) {
        console.warn('AI analysis failed, using deterministic fallback:', (error as Error).message);
      }
    }

    const fallback = this.fallbackAnalysis(input, files);
    return limited ? this.constrainToParentScope(fallback, editableFiles, readonlyFiles) : fallback;
  }

  private constrainToParentScope(analysis: TaskAnalysis, editableFiles: string[], readonlyFiles: string[]): TaskAnalysis {
    const materialize = (patterns: string[], allowed: string[]): string[] => allowed.filter((file) =>
      patterns.some((pattern) => minimatch(file, pattern, { dot: true, nocase: process.platform === 'win32' }))
    );
    const editable = materialize(analysis.scope.editablePaths, editableFiles);
    const safeEditable = editable.length ? editable : editableFiles.slice(0, 6);
    const readonly = materialize(analysis.scope.readonlyPaths, readonlyFiles)
      .filter((file) => !safeEditable.includes(file));
    return {
      ...analysis,
      confidence: safeEditable.length ? analysis.confidence : 'low',
      rationale: `${analysis.rationale} 子任务范围已限制在父任务公开的 ${editableFiles.length + readonlyFiles.length} 个文件内。`,
      scope: {
        ...analysis.scope,
        editablePaths: safeEditable,
        readonlyPaths: readonly,
      },
    };
  }

  private fallbackAnalysis(input: AnalyzeInput, files: string[]): TaskAnalysis {
    const terms = `${input.title} ${input.description}`
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter((term) => term.length >= 3);
    const scored = files
      .map((file) => ({ file, score: terms.reduce((sum, term) => sum + (file.toLowerCase().includes(term) ? 1 : 0), 0) }))
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    let editable = scored.filter((item) => item.score > 0).slice(0, 8).map((item) => item.file);
    if (editable.length === 0) {
      editable = files.filter((file) => /^(src|app|apps|packages)\//.test(file) && /\.(ts|tsx|js|jsx|py|go|rs)$/.test(file)).slice(0, 6);
    }
    const readonly = CONFIG_FILES.filter((file) => files.includes(file));
    const tests = files.filter((file) => /(test|spec)\.(ts|tsx|js|jsx|py)$/.test(file)).slice(0, 5);
    const breadth = Math.max(1, editable.length);
    return {
      summary: input.description.trim() || `完成“${input.title}”，并提供可验证的交付结果。`,
      acceptanceCriteria: [
        `完成“${input.title}”描述的核心行为`,
        '相关构建、类型检查或测试通过',
        '交付文档列明修改范围、验证结果和已知风险',
      ],
      suggestedPoints: Math.min(500, 40 + breadth * 15 + Math.ceil(input.description.length / 100) * 10),
      confidence: editable.length > 0 ? 'medium' : 'low',
      rationale: `根据 ${files.length} 个仓库文件和 ${editable.length} 个候选修改文件生成；配置模型后可获得更准确估价。`,
      scope: normalizeScope({
        editablePaths: editable,
        readonlyPaths: readonly.filter((file) => !editable.includes(file)),
        visibleTests: tests,
        environment: {
          image: files.includes('package.json') ? 'node:22-bookworm' : 'ubuntu:24.04',
          setupCommands: files.includes('package.json') ? ['npm ci'] : [],
          testCommands: files.includes('package.json') ? ['npm run typecheck', 'npm test'] : [],
          networkAllowlist: ['registry.npmjs.org', 'github.com'],
        },
      }, input.inheritedDeniedPaths),
    };
  }

  async review(input: ReviewInput): Promise<ReviewResult> {
    if (this.client) {
      try {
        const response = await this.client.chat.completions.create({
          model: config.ai.model,
          temperature: 0.1,
          messages: [
            {
              role: 'system',
              content:
                '你是严格但公正的 Techunter 交付审查 Agent。输出严格 JSON：score(0-100)、verdict(approved|changes_requested)、summary、' +
                'findings[{criterion,passed,evidence}]、risks(string[])、deliveryDocument(markdown)。只依据任务、变更文件和测试证据判断。',
            },
            {
              role: 'user',
              content: JSON.stringify({
                task: { title: input.title, description: input.description, acceptanceCriteria: input.acceptanceCriteria },
                submission: { summary: input.summary, testOutput: input.testOutput, changedFiles: input.changedFiles },
              }),
            },
          ],
        });
        const result = jsonFromText<ReviewResult>(response.choices[0]?.message.content ?? '');
        return {
          ...result,
          score: Math.max(0, Math.min(100, Math.round(result.score))),
          findings: result.findings ?? [],
          risks: result.risks ?? [],
        };
      } catch (error) {
        console.warn('AI review failed, using deterministic fallback:', (error as Error).message);
      }
    }

    const hasChanges = input.changedFiles.length > 0;
    const testFailed = /(^|\n)\s*(fail|failed|error)\b/i.test(input.testOutput);
    const verdict = hasChanges && !testFailed ? 'approved' : 'changes_requested';
    const findings = input.acceptanceCriteria.map((criterion) => ({
      criterion,
      passed: verdict === 'approved',
      evidence: hasChanges
        ? `${input.changedFiles.length} 个范围内文件发生变更；${input.testOutput ? '已附测试输出' : '未提供测试输出'}`
        : '工作包中没有检测到允许范围内的文件变更。',
    }));
    const deliveryDocument = [
      `# ${input.title} · 交付文档`,
      '',
      '## 完成内容',
      input.summary || '提交者未填写摘要。',
      '',
      '## 修改文件',
      ...(input.changedFiles.length ? input.changedFiles.map((file) => `- \`${file.path}\``) : ['- 无']),
      '',
      '## 验证结果',
      input.testOutput ? `\`\`\`text\n${input.testOutput.slice(0, 4000)}\n\`\`\`` : '未提供测试输出。',
      '',
      '## 审查结论',
      verdict === 'approved' ? '通过自动预审，等待维护者验收。' : '需要修改后重新提交。',
    ].join('\n');
    return {
      score: verdict === 'approved' ? (input.testOutput ? 88 : 76) : 35,
      verdict,
      summary: verdict === 'approved' ? '变更范围有效，自动预审通过。' : '缺少有效变更或测试存在失败。',
      findings,
      risks: input.testOutput ? [] : ['没有提交测试输出，维护者应在合并前补充验证。'],
      deliveryDocument,
    };
  }

  async readProjectReadme(repoPath: string | null): Promise<string> {
    if (!repoPath) return '';
    try {
      return (await fs.readFile(path.join(repoPath, 'README.md'), 'utf8')).slice(0, 6000);
    } catch {
      return '';
    }
  }
}
