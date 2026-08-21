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

  review(input: ReviewInput): Promise<DeliveryReview> {
    return reviewDeliveryWithAgent({
      config: this.aiConfig(input.modelCredential, input.modelAudience),
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      changedFiles: input.changedFiles.map((file) => ({ path: file.path, content: file.content?.slice(0, 30_000) ?? null })),
      testOutput: input.testOutput,
      summary: input.summary,
    });
  }

  private aiConfig(modelCredential?: string, modelAudience?: string) {
    const value = config();
    if (value.ai.accessMode === 'conexus') {
      if (!modelCredential || !modelAudience) throw httpError('Conexus 授权已过期，请重新登录。', 401);
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
