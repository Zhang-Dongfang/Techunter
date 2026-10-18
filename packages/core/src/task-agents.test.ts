import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeTaskWithAgent, reviewDeliveryWithAgent } from './task-agents.js';
import { runAgentLoop } from './agent-runtime.js';

const config = { aiApiKey: 'ticket', aiAccessMode: 'conexus' as const, aiAudience: 'techunter' };

test('collaborative analysis synthesizes both research nodes and retains deterministic scope restrictions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'techunter-node-analysis-'));
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'allowed.ts'), 'export const allowed = true;');
    await fs.writeFile(path.join(root, 'secret.ts'), 'private evidence');
    let research = 0, synthesis = 0;
    const runAgent: typeof runAgentLoop = async input => {
      assert.equal(input.config, config);
      assert.ok(input.tools!.every(tool => tool.definition.function.name !== 'run_command'));
      if (!input.systemPrompt.includes('task specification Agent')) {
        const files = await input.tools!.find(tool => tool.definition.function.name === 'list_files')!.execute({}, { signal: input.signal! });
        assert.match(files, /allowed.ts/);
        assert.doesNotMatch(files, /secret.ts/);
        research++;
        return 'src/allowed.ts is relevant; add a concrete test.';
      }
      synthesis++;
      assert.equal(research, 2);
      assert.deepEqual(Object.keys(JSON.parse(input.userMessage).dependencies), ['implementation', 'verification']);
      return JSON.stringify({ summary: 'Implement change', acceptanceCriteria: ['works'], suggestedPoints: 20,
        confidence: 'high', rationale: 'code evidence', scope: {
          editablePaths: ['src/allowed.ts', 'src/new.ts', 'secret.ts', '.env'],
          readonlyPaths: [], deniedPaths: [], visibleTests: [], environment: {},
        } });
    };
    const result = await analyzeTaskWithAgent({ config, title: 'change', description: 'implement', collaboration: true, runAgent,
      repository: { root, allowCommands: true, editablePatterns: ['src/**'], deniedPatterns: ['secret.ts'] } });
    assert.deepEqual(result.scope.editablePaths, ['src/allowed.ts', 'src/new.ts']);
    assert.equal(synthesis, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('every review node receives full delivery evidence and synthesis receives both independent findings', async () => {
  const tail = 'x'.repeat(31_000) + 'critical tail evidence';
  let calls = 0;
  const runAgent: typeof runAgentLoop = async input => {
    calls++;
    assert.match(input.userMessage, /critical tail evidence/);
    assert.match(input.userMessage, /base64/);
    const data = JSON.parse(JSON.parse(input.userMessage).request);
    assert.equal(data.submission.changedFiles[0].content, tail);
    if (!input.systemPrompt.includes('delivery review Agent')) return 'A blocking criterion lacks evidence.';
    assert.deepEqual(Object.keys(JSON.parse(input.userMessage).dependencies), ['correctness', 'risk']);
    return JSON.stringify({ score: 40, verdict: 'changes_requested', summary: 'Evidence missing',
      findings: [{ criterion: 'works', passed: false, evidence: 'missing coverage' }], risks: ['unverified binary'], deliveryDocument: '# Review' });
  };
  const review = await reviewDeliveryWithAgent({ config, title: 'change', description: 'implement', collaboration: true, runAgent,
    acceptanceCriteria: ['works'], summary: 'done', testOutput: 'claimed success',
    changedFiles: [{ path: 'large.ts', content: tail }, { path: 'asset.png', content: 'AA==', encoding: 'base64' }] });
  assert.equal(calls, 3);
  assert.equal(review.verdict, 'changes_requested');
});
