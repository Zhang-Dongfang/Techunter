import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgentGraph, type AgentNode } from './agent-graph.js';
import { runAgentLoop } from './agent-runtime.js';
import type { AgentUsage } from './types.js';

const config = { aiApiKey: 'fixture' };
const nodes: AgentNode[] = [
  { id: 'code', systemPrompt: 'code' },
  { id: 'tests', systemPrompt: 'tests' },
  { id: 'synthesis', systemPrompt: 'synthesis', dependsOn: ['code', 'tests'] },
];

test('runs independent nodes concurrently and passes declared evidence to synthesis with a shared budget', async () => {
  const started: string[] = [];
  const usages: AgentUsage[] = [];
  let release!: () => void;
  const bothStarted = new Promise<void>(resolve => { release = resolve; });
  const runner: typeof runAgentLoop = async input => {
    started.push(input.systemPrompt);
    assert.equal(input.maxTotalTokens, 100);
    const message = JSON.parse(input.userMessage);
    if (input.systemPrompt !== 'synthesis') {
      assert.deepEqual(message.dependencies, {});
      if (started.length === 2) release();
      await bothStarted;
    } else {
      assert.deepEqual(message.dependencies, { code: 'code evidence', tests: 'tests evidence' });
    }
    input.hooks?.onUsage?.({ iteration: 1, promptTokens: 10, completionTokens: 2, totalTokens: 12, elapsedMs: 1 });
    return `${input.systemPrompt} evidence`;
  };
  const outputs = await runAgentGraph({ config, nodes, userMessage: 'task', maxTotalTokens: 300,
    runAgent: runner, hooks: { onUsage: usage => usages.push(usage) } });
  assert.equal(outputs['synthesis'], 'synthesis evidence');
  assert.deepEqual(started, ['code', 'tests', 'synthesis']);
  assert.deepEqual(usages.map(usage => usage.totalTokens), [12, 24, 36]);
});

test('rejects invalid graphs and pre-cancelled requests before running any node', async () => {
  const runAgent: typeof runAgentLoop = async () => { throw new Error('should not run'); };
  for (const invalid of [[], [nodes[0]!, nodes[0]!], [{ ...nodes[0]!, dependsOn: ['missing'] }],
    [{ ...nodes[0]!, dependsOn: ['tests'] }, { ...nodes[1]!, dependsOn: ['code'] }]]) {
    await assert.rejects(() => runAgentGraph({ config, nodes: invalid, userMessage: '', runAgent }), /graph|dependency|IDs/);
  }
  await assert.rejects(() => runAgentGraph({ config, nodes, userMessage: '', runAgent,
    signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
});

test('failure cancels and drains siblings before returning, and never starts dependent nodes', async () => {
  let siblingStarted!: () => void;
  const ready = new Promise<void>(resolve => { siblingStarted = resolve; });
  let drained = false;
  const events: string[] = [];
  const runAgent: typeof runAgentLoop = async input => {
    if (input.systemPrompt === 'code') { await ready; throw new Error('research failed'); }
    assert.equal(input.systemPrompt, 'tests');
    siblingStarted();
    await new Promise<void>(resolve => input.signal!.addEventListener('abort', () => resolve(), { once: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
    drained = true;
    input.signal!.throwIfAborted();
    return '';
  };
  await assert.rejects(() => runAgentGraph({ config, nodes, userMessage: '', runAgent,
    hooks: { onNodeState: event => events.push(`${event.nodeId}:${event.status}`) } }), /research failed/);
  assert.equal(drained, true);
  assert.ok(events.includes('code:failed'));
  assert.ok(events.includes('tests:cancelled'));
  assert.ok(!events.some(event => event.startsWith('synthesis:')));
});

test('one deadline covers the whole graph, including in-flight nodes', async () => {
  const alive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(() => runAgentGraph({ config, nodes, userMessage: '', maxRuntimeMs: 20,
      runAgent: async input => new Promise((_resolve, reject) => {
        input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true });
      }),
    }), /timeout|aborted/i);
  } finally { clearInterval(alive); }
});

test('respects a lower concurrency limit without sharing unrelated node outputs', async () => {
  let active = 0, peak = 0;
  const result = await runAgentGraph({ config, userMessage: 'shared', maxConcurrency: 1,
    nodes: [nodes[0]!, { ...nodes[1]!, userMessage: 'specific' }],
    runAgent: async input => {
      peak = Math.max(peak, ++active);
      const request = JSON.parse(input.userMessage);
      assert.deepEqual(request.dependencies, {});
      assert.equal(request.request, input.systemPrompt === 'tests' ? 'specific' : 'shared');
      await Promise.resolve();
      active--;
      return input.systemPrompt;
    },
  });
  assert.equal(peak, 1);
  assert.deepEqual(result, { code: 'code', tests: 'tests' });
});
