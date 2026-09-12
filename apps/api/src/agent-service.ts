import {
  analyzeTaskWithAgent,
  reviewDeliveryWithAgent,
  type DeliveryReview,
  type PackageFile,
  type Project,
  type TaskSpec,
} from '@techunter/core';
import { config } from './config.js';
import { GitHubService } from './github-service.js';
import { httpError } from './errors.js';

export interface AnalyzeInput {
  title: string;
  description: string;
  project: Project;
  githubCredential?: string;
  editableLimit?: string[];
  readonlyLimit?: string[];
  inheritedDeniedPaths?: string[];
  modelCredential?: string;
  modelAudience?: string;
}

export interface ReviewInput {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  changedFiles: PackageFile[];
  testOutput: string;
  summary: string;
  modelCredential?: string;
  modelAudience?: string;
}

export function reviewEvidence(input: ReviewInput) {
  // Never silently review only a file prefix. Reject an oversized package before
  // calling the model, so the submitter can split it into smaller deliveries.
  const evidence = input.changedFiles.map(file => ({ path: file.path, content: file.content, encoding: file.encoding }));
  const length = JSON.stringify({ ...input, modelCredential: undefined, modelAudience: undefined, changedFiles: evidence }).length;
  if (length > 250_000) throw httpError('完整交付证据超过本次模型审查上限，请拆分任务或缩小交付；文件内容未截断。', 413, 'REVIEW_EVIDENCE_TOO_LARGE');
  return evidence;
}

export class AgentService {
  constructor(private readonly github: GitHubService) {}

  get configured(): boolean {
    const value = config().ai;
    return value.accessMode === 'conexus' || Boolean(value.apiKey);
  }

  async analyze(input: AnalyzeInput): Promise<TaskSpec> {
    const aiConfig = this.aiConfig(input.modelCredential, input.modelAudience);
    const checkout = await this.github.materialize(input.project, input.githubCredential);
    try {
      return await analyzeTaskWithAgent({
        config: aiConfig,
        title: input.title,
        description: input.description,
        repository: {
          root: checkout.root,
          editablePatterns: input.editableLimit,
          readonlyPatterns: input.readonlyLimit,
          deniedPatterns: input.inheritedDeniedPaths,
          allowCommands: false,
        },
      });
    } finally {
      await checkout.cleanup();
    }
  }

  async review(input: ReviewInput): Promise<DeliveryReview> {
    const evidence = reviewEvidence(input);
    const review = await reviewDeliveryWithAgent({
      config: this.aiConfig(input.modelCredential, input.modelAudience),
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      changedFiles: evidence,
      testOutput: input.testOutput,
      summary: input.summary,
    });
    review.risks = [...new Set([...review.risks, '测试输出来自执行者本机，中央服务未独立复跑测试。'])];
    return review;
  }

  private aiConfig(modelCredential?: string, modelAudience?: string) {
    const value = config();
    if (value.ai.accessMode === 'conexus') {
      if (!modelCredential || !modelAudience) {
        throw httpError('Conexus 模型授权已过期，请重新授权。', 401, 'CONEXUS_AUTHORIZATION_REQUIRED');
      }
      return {
        aiApiKey: modelCredential,
        aiAccessMode: value.ai.accessMode,
        aiBaseUrl: value.ai.baseUrl,
        aiModel: value.ai.model,
        aiAudience: modelAudience,
        aiPublicationSlug: value.conexus.publicationSlug,
      };
    }
    if (!value.ai.apiKey) throw httpError('Task Agent 未配置。', 503);
    return {
      aiApiKey: value.ai.apiKey,
      aiAccessMode: value.ai.accessMode,
      aiBaseUrl: value.ai.baseUrl,
      aiModel: value.ai.model,
    };
  }
}
