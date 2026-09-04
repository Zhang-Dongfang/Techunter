export type AiAccessMode = 'direct' | 'conexus';

export interface AiConfig {
  aiApiKey: string;
  aiAccessMode?: AiAccessMode;
  aiBaseUrl?: string;
  aiModel?: string;
  aiAudience?: string;
  aiPublicationSlug?: string;
}

export interface AgentTool {
  definition: {
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  };
  execute(input: Record<string, unknown>): Promise<string>;
}

export interface AgentHooks {
  onToolCall?(name: string, input: Record<string, unknown>): void;
  onToolResult?(name: string, result: string): void;
}

export interface AgentChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TaskScope {
  revision: number;
  editablePaths: string[];
  readonlyPaths: string[];
  deniedPaths: string[];
  visibleTests: string[];
  environment: {
    setupCommands: string[];
    testCommands: string[];
    networkAllowlist: string[];
  };
}

export interface TaskSpec {
  summary: string;
  acceptanceCriteria: string[];
  scope: TaskScope;
  suggestedPoints: number;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
}

export interface DeliveryFinding {
  criterion: string;
  passed: boolean;
  evidence: string;
}

export interface DeliveryReview {
  score: number;
  verdict: 'approved' | 'changes_requested';
  summary: string;
  findings: DeliveryFinding[];
  risks: string[];
  deliveryDocument: string;
}

export interface RepositoryAccess {
  root: string;
  editablePatterns?: string[];
  readonlyPatterns?: string[];
  deniedPatterns?: string[];
  allowCommands?: boolean;
}
