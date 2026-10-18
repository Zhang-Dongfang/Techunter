import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgentLoop, type AgentTool } from '@techunter/core';
import { createAssistantNodeTool } from './assistant-nodes.js';

const tool = (name: string): AgentTool => ({ definition: { type: 'function', function: { name } }, execute: async () => name });

test('delegated nodes receive their actual assignments and only authorized read tools, with no recursive delegation', async () => {
  const requests: string[] = [];
  const runAgent: typeof runAgentLoop = async input => {
    const names = input.tools!.map(value => value.definition.function.name);
    assert.deepEqual(names, ['list_tasks', 'get_task', 'list_files', 'grep_code']);
    assert.equal(input.maxTotalTokens, 10_000);
    requests.push(JSON.parse(input.userMessage).request);
    return 'evidence';
  };
  const delegate = createAssistantNodeTool({ config: { aiApiKey: 'fixture' }, runAgent,
    tools: ['list_tasks', 'get_task', 'list_files', 'grep_code', 'create_task', 'claim_task', 'create_workspace', 'run_command', 'run_agent_nodes'].map(tool) });
  const response = JSON.parse(await delegate.execute({ tasks: [
    { node: 'repository', task: 'find implementation with file references' },
    { node: 'verification', task: 'check coverage with evidence' },
  ] }));
  assert.equal(Object.keys(response).length, 2);
  assert.deepEqual(requests, ['find implementation with file references', 'check coverage with evidence']);
});

test('validates unknown roles and limits total delegated work across batches before model calls', async () => {
  let calls = 0;
  const delegate = createAssistantNodeTool({ config: { aiApiKey: 'fixture' }, tools: [],
    runAgent: async () => { calls++; return 'evidence'; } });
  await assert.rejects(() => delegate.execute({ tasks: [{ node: '__proto__', task: 'escape' }] }), /known research node/);
  const tasks = Array.from({ length: 3 }, () => ({ node: 'planning', task: 'plan' }));
  await delegate.execute({ tasks });
  await delegate.execute({ tasks });
  await assert.rejects(() => delegate.execute({ tasks }), /budget exhausted/);
  assert.equal(calls, 6);
  await assert.rejects(() => delegate.execute({ tasks }, { signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
});
