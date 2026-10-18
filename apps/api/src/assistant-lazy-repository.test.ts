import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type Project, type User, type AgentUsage, runAgentLoop } from '@techunter/core';
import { AssistantService } from './assistant-service.js';
import type { TaskService } from './task-service.js';
import type { GitHubService } from './github-service.js';
import type { ApiConfig } from './config.js';

const project = { id: 'project', name: 'Fixture', repoOwner: 'fixture', repoName: 'fixture' } as Project;
const user = { id: 'user', name: 'User', login: 'user', role: 'member' } as User;
const configuration = () => ({ ai: { accessMode: 'direct', apiKey: 'fixture-key' }, conexus: {} }) as ApiConfig;
const tasks = { projects: async () => [project] } as unknown as TaskService;

test('chat delegates parallel research with one lazy checkout, node activities and combined usage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'techunter-assistant-nodes-'));
  await fs.writeFile(path.join(root, 'README.md'), 'fixture evidence');
  let downloads = 0, cleanups = 0, refreshes = 0;
  const github = { materialize: async () => {
    downloads++;
    return { root, cleanup: async () => { cleanups++; } };
  } } as unknown as GitHubService;
  const reported: AgentUsage[] = [];
  const runner: typeof runAgentLoop = async input => {
    input.hooks?.onUsage?.({ iteration: 1, promptTokens: 10, completionTokens: 2, totalTokens: 12, elapsedMs: 1 });
    const delegate = input.tools!.find(tool => tool.definition.function.name === 'run_agent_nodes');
    if (delegate) {
      assert.equal(input.maxTotalTokens, 60_000);
      await delegate.execute({ tasks: [{ node: 'repository', task: 'find source' }, { node: 'verification', task: 'verify source' }] },
        { signal: new AbortController().signal });
      assert.equal(cleanups, 0);
      return 'Integrated evidence';
    }
    const list = input.tools!.find(tool => tool.definition.function.name === 'list_files')!;
    assert.match(await list.execute({}, { signal: input.signal! }), /README.md/);
    return 'README.md: fixture evidence';
  };
  try {
    const service = new AssistantService(tasks, github, configuration, usage => reported.push(usage), runner);
    const result = await service.chat({ user, message: 'inspect and verify', history: [],
      getGitHubCredential: async () => { refreshes++; return 'credential'; } });
    assert.deepEqual([downloads, refreshes, cleanups], [1, 1, 1]);
    assert.equal(result.reply, 'Integrated evidence');
    assert.equal(result.activities.filter(activity => activity.name === 'agent_node').length, 4);
    assert.equal(reported.at(-1)!.totalTokens, 36);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('task-only conversations need neither a repository download nor GitHub credential refresh', async () => {
  const github = { materialize: async () => { throw new Error('repository must not be loaded'); } } as unknown as GitHubService;
  const runner: typeof runAgentLoop = async input => {
    assert.ok(input.tools?.some(tool => tool.definition.function.name === 'list_files'));
    return 'Task information';
  };
  const service = new AssistantService(tasks, github, configuration, undefined, runner);
  const result = await service.chat({ user, message: 'list tasks', history: [],
    getGitHubCredential: async () => { throw new Error('credential refresh must not be called'); } });
  assert.equal(result.reply, 'Task information');
});

test('source tools share one authorized checkout and always clean it up after a model failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'techunter-assistant-fixture-'));
  await fs.writeFile(path.join(root, 'README.md'), 'fixture evidence');
  let downloads = 0, cleanups = 0, refreshes = 0;
  const github = { materialize: async (selected: Project, credential: string) => {
    assert.equal(selected.id, project.id);
    assert.equal(credential, 'fresh-credential');
    downloads++;
    return { root, cleanup: async () => { cleanups++; } };
  } } as unknown as GitHubService;
  const usage: AgentUsage = { iteration: 1, promptTokens: 10, completionTokens: 2, totalTokens: 12, elapsedMs: 5 };
  const reported: AgentUsage[] = [];
  const runner: typeof runAgentLoop = async input => {
    const list = input.tools!.find(tool => tool.definition.function.name === 'list_files')!;
    const grep = input.tools!.find(tool => tool.definition.function.name === 'grep_code')!;
    const context = { signal: new AbortController().signal };
    assert.match(await list.execute({}, context), /README.md/);
    assert.match(await grep.execute({ pattern: 'fixture' }, context), /fixture evidence/);
    input.hooks?.onUsage?.(usage);
    throw new Error('model failed');
  };
  try {
    const service = new AssistantService(tasks, github, configuration, value => reported.push(value), runner);
    await assert.rejects(() => service.chat({ user, message: 'inspect code', history: [],
      getGitHubCredential: async () => { refreshes++; return 'fresh-credential'; } }), /model failed/);
    assert.deepEqual([downloads, refreshes, cleanups], [1, 1, 1]);
    assert.deepEqual(reported, [usage]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a cancelled repository request does not refresh credentials or download source', async () => {
  const github = { materialize: async () => { throw new Error('repository must not be loaded'); } } as unknown as GitHubService;
  const runner: typeof runAgentLoop = async input => {
    const tool = input.tools!.find(candidate => candidate.definition.function.name === 'list_files')!;
    return tool.execute({}, { signal: AbortSignal.abort(new Error('cancelled')) });
  };
  const service = new AssistantService(tasks, github, configuration, undefined, runner);
  await assert.rejects(() => service.chat({ user, message: 'inspect code', history: [],
    getGitHubCredential: async () => { throw new Error('credential refresh must not be called'); } }), /cancelled/);
});

test('an aborted chat stops before querying platform state and live cancellation reaches the runtime', async () => {
  const unavailableTasks = { projects: async () => { throw new Error('platform must not be queried'); } } as unknown as TaskService;
  const preCancelled = new AssistantService(unavailableTasks, {} as GitHubService, configuration);
  await assert.rejects(() => preCancelled.chat({ user, message: 'fixture', history: [], signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
  const controller = new AbortController();
  const runner: typeof runAgentLoop = async input => {
    assert.equal(input.signal, controller.signal);
    controller.abort(new Error('client disconnected'));
    input.signal!.throwIfAborted();
    return '';
  };
  const live = new AssistantService(tasks, {} as GitHubService, configuration, undefined, runner);
  await assert.rejects(() => live.chat({ user, message: 'fixture', history: [], signal: controller.signal }), /client disconnected/);
});
