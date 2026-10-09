import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import { runAgentLoop } from './agent-runtime.js';
import type { AgentUsage } from './types.js';

const base = { config: { aiApiKey: 'fixture-key' }, systemPrompt: 'fixture', userMessage: 'fixture' };
function client(create: (body: any, options: any) => Promise<any>): Pick<OpenAI, 'chat'> {
  return { chat: { completions: { create } } } as unknown as Pick<OpenAI, 'chat'>;
}
const answer = (content = 'done', tokens = 10) => ({ choices: [{ finish_reason: 'stop', message: { content } }],
  usage: { prompt_tokens: tokens - 2, completion_tokens: 2, total_tokens: tokens } });
const call = (argumentsText = '{}') => ({ choices: [{ finish_reason: 'tool_calls', message: { content: null,
  tool_calls: [{ id: 'call', type: 'function', function: { name: 'fixture', arguments: argumentsText } }] } }],
  usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } });

test('reports cumulative usage and limits tool output and completion size', async () => {
  const usages: AgentUsage[] = [];
  let calls = 0;
  const result = await runAgentLoop({ ...base, maxToolResultChars: 20, maxOutputTokens: 32,
    hooks: { onUsage: usage => usages.push(usage) },
    tools: [{ definition: { type: 'function', function: { name: 'fixture' } }, execute: async () => 'x'.repeat(1000) }],
    client: client(async (body, options) => {
      assert.equal(body.max_tokens, 32);
      assert.equal(options.maxRetries, 0);
      assert.ok(options.signal instanceof AbortSignal);
      if (calls++ === 0) return call();
      const output = body.messages.at(-1).content;
      assert.match(output, /Tool output truncated/);
      assert.ok(output.length < 150);
      return answer();
    }),
  });
  assert.equal(result, 'done');
  assert.deepEqual(usages.map(usage => usage.totalTokens), [10, 20]);
  assert.equal(usages[1]!.promptTokens, 16);
});

test('rejects oversized context and pre-cancelled runs without contacting the model', async () => {
  const never = client(async () => { throw new Error('model should not be called'); });
  await assert.rejects(() => runAgentLoop({ ...base, client: never, maxContextChars: 1 }), /上下文超过预算/);
  await assert.rejects(() => runAgentLoop({ ...base, client: never, signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
});

test('runtime deadline aborts an in-flight model request', async () => {
  const slow = client(async (_body, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  // Keep the fake transport alive, as a real HTTP request would be.
  const alive = setInterval(() => {}, 1000);
  try { await assert.rejects(() => runAgentLoop({ ...base, client: slow, maxRuntimeMs: 20 }), /timeout|aborted/i); }
  finally { clearInterval(alive); }
});

test('token and output-length limits prevent tools from executing', async () => {
  let executions = 0;
  const tools = [{ definition: { type: 'function' as const, function: { name: 'fixture' } }, execute: async () => { executions++; return ''; } }];
  await assert.rejects(() => runAgentLoop({ ...base, tools, maxTotalTokens: 5, client: client(async () => call()) }), /token 预算/);
  await assert.rejects(() => runAgentLoop({ ...base, tools, client: client(async () => ({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] })) }), /输出被截断/);
  assert.equal(executions, 0);
});

test('malformed arguments are returned to the model without invoking a mutating tool', async () => {
  for (const argumentsText of ['{', '[]', 'null']) {
    let calls = 0, executions = 0;
    await runAgentLoop({ ...base,
      tools: [{ definition: { type: 'function', function: { name: 'fixture' } }, execute: async () => { executions++; return ''; } }],
      client: client(async body => {
        if (calls++ === 0) return call(argumentsText);
        assert.match(body.messages.at(-1).content, /invalid JSON object/);
        return answer();
      }),
    });
    assert.equal(executions, 0);
  }
});

test('cancellation inside one tool prevents later tool calls', async () => {
  const controller = new AbortController();
  let executions = 0;
  await assert.rejects(() => runAgentLoop({ ...base, signal: controller.signal,
    tools: [{ definition: { type: 'function', function: { name: 'fixture' } }, execute: async (_input, context) => {
      executions++;
      assert.ok(context?.signal);
      controller.abort(new Error('cancelled during tool'));
      return '';
    } }],
    client: client(async () => { const response = call(); response.choices[0]!.message.tool_calls!.push({ ...response.choices[0]!.message.tool_calls![0]!, id: 'second' }); return response; }),
  }), /cancelled during tool/);
  assert.equal(executions, 1);
});
