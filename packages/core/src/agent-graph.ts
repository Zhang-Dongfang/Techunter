import { runAgentLoop } from './agent-runtime.js';
import type { AgentHooks, AgentTool, AiConfig } from './types.js';

export interface AgentNode {
  id: string;
  systemPrompt: string;
  userMessage?: string;
  dependsOn?: string[];
  tools?: AgentTool[];
}

export interface AgentNodeEvent {
  nodeId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
}

export interface AgentGraphInput {
  config: AiConfig;
  nodes: AgentNode[];
  userMessage: string;
  hooks?: AgentHooks;
  signal?: AbortSignal;
  maxConcurrency?: number;
  maxRuntimeMs?: number;
  maxTotalTokens?: number;
  runAgent?: typeof runAgentLoop;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}

/** Validate the complete graph before a model call or tool can execute. */
function validate(nodes: AgentNode[]): void {
  if (!nodes.length || nodes.length > 16) throw new Error('Agent graph requires 1–16 nodes.');
  const ids = new Set(nodes.map(node => node.id));
  if (ids.size !== nodes.length || nodes.some(node => !node.id.trim())) throw new Error('Agent node IDs must be unique and nonempty.');
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (node: AgentNode) => {
    if (visiting.has(node.id)) throw new Error('Agent graph contains a dependency cycle.');
    if (visited.has(node.id)) return;
    visiting.add(node.id);
    for (const id of node.dependsOn ?? []) {
      const dependency = nodes.find(candidate => candidate.id === id);
      if (!dependency) throw new Error(`Unknown Agent dependency: ${id}`);
      visit(dependency);
    }
    visiting.delete(node.id);
    visited.add(node.id);
  };
  nodes.forEach(visit);
}

/** Independent nodes run concurrently; dependent nodes receive only their declared outputs. */
export async function runAgentGraph(input: AgentGraphInput): Promise<Record<string, string>> {
  validate(input.nodes);
  const concurrency = positive(input.maxConcurrency ?? 2, 'maxConcurrency');
  const runtime = positive(input.maxRuntimeMs ?? 180_000, 'maxRuntimeMs');
  const tokens = positive(input.maxTotalTokens ?? 120_000, 'maxTotalTokens');
  const nodeTokens = Math.floor(tokens / input.nodes.length);
  if (!nodeTokens) throw new Error('Agent graph token budget is too small.');
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(runtime), ...(input.signal ? [input.signal] : [])]);
  signal.throwIfAborted();
  const startedAt = Date.now();
  const results = new Map<string, string>();
  const usages = new Map<string, { iteration: number; promptTokens: number; completionTokens: number; totalTokens: number }>();
  const pending = new Set(input.nodes);
  while (pending.size) {
    signal.throwIfAborted();
    const ready = [...pending].filter(node => (node.dependsOn ?? []).every(id => results.has(id))).slice(0, concurrency);
    const batch = await Promise.allSettled(ready.map(async node => {
      pending.delete(node);
      try {
        signal.throwIfAborted();
        input.hooks?.onNodeState?.({ nodeId: node.id, status: 'running' });
        const output = await (input.runAgent ?? runAgentLoop)({
          config: input.config,
          systemPrompt: node.systemPrompt,
          userMessage: JSON.stringify({
            request: node.userMessage ?? input.userMessage,
            dependencies: Object.fromEntries((node.dependsOn ?? []).map(id => [id, results.get(id)])),
          }),
          tools: node.tools,
          signal,
          maxRuntimeMs: Math.max(1, runtime - (Date.now() - startedAt)),
          // Reserve a fixed share for every node, including nodes still pending.
          // Concurrent branches cannot each consume the entire run's budget.
          maxTotalTokens: nodeTokens,
          hooks: {
            onToolCall: input.hooks?.onToolCall,
            onToolResult: input.hooks?.onToolResult,
            onUsage(usage) {
              usages.set(node.id, usage);
              const values = [...usages.values()];
              input.hooks?.onUsage?.({
                iteration: values.reduce((sum, value) => sum + value.iteration, 0),
                promptTokens: values.reduce((sum, value) => sum + value.promptTokens, 0),
                completionTokens: values.reduce((sum, value) => sum + value.completionTokens, 0),
                totalTokens: values.reduce((sum, value) => sum + value.totalTokens, 0),
                elapsedMs: Date.now() - startedAt,
              });
            },
          },
        });
        signal.throwIfAborted();
        results.set(node.id, output);
        input.hooks?.onNodeState?.({ nodeId: node.id, status: 'completed' });
      } catch (error) {
        const cancelled = signal.aborted;
        controller.abort(error);
        input.hooks?.onNodeState?.({ nodeId: node.id, status: cancelled ? 'cancelled' : 'failed' });
        throw error;
      }
    }));
    // Drain cancelled siblings before the caller releases shared repository resources.
    if (batch.some(result => result.status === 'rejected')) throw signal.reason;
  }
  return Object.fromEntries(results);
}
