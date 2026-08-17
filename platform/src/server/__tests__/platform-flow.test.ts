import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Submission, Task, Workspace } from '../../shared/contracts.js';
import { AgentService } from '../agent-service.js';
import { buildApp } from '../app.js';
import { Database, ensureUser } from '../database.js';
import { LedgerService } from '../ledger.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const target of cleanupPaths.splice(0)) {
    await fs.rm(target, { recursive: true, force: true });
  }
});

function cookieFrom(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : typeof raw === 'string' ? raw : undefined;
  if (!value) throw new Error('登录响应没有 session cookie。');
  return value.split(';', 1)[0]!;
}

describe('Techunter internal pilot flow', () => {
  it('provisions contribution accounts for every new user', () => {
    const database = new Database(':memory:');
    try {
      const userId = ensureUser(database, { login: 'oauth.hunter', name: 'OAuth 猎人' });
      const ledger = new LedgerService(database);
      expect(ledger.balance('user', userId)).toBe(0);
      expect(ledger.balance('user', userId, 'reserved')).toBe(0);
    } finally {
      database.close();
    }
  });

  it('keeps child-task analysis inside the parent-visible file set', async () => {
    const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'techunter-scope-'));
    cleanupPaths.push(repository);
    await fs.mkdir(path.join(repository, 'src'), { recursive: true });
    await fs.mkdir(path.join(repository, 'private'), { recursive: true });
    await fs.writeFile(path.join(repository, 'src', 'public.ts'), 'export const publicValue = 1;\n');
    await fs.writeFile(path.join(repository, 'private', 'payroll.ts'), 'export const payroll = [];\n');
    await fs.writeFile(path.join(repository, 'package.json'), '{}\n');

    const result = await new AgentService().analyze({
      title: '修改 payroll 私密模块',
      description: '尝试读取并修改未向父任务公开的 payroll 文件。',
      repoPath: repository,
      editableLimit: ['src/public.ts'],
      readonlyLimit: ['package.json'],
      inheritedDeniedPaths: ['private/**'],
    });

    expect(result.scope.editablePaths).toEqual(['src/public.ts']);
    expect(result.scope.readonlyPaths.every((file) => file !== 'private/payroll.ts')).toBe(true);
    expect(result.scope.deniedPaths).toContain('private/**');
  });

  it('runs publish → claim → isolated workspace → AI review → settlement', async () => {
    const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'techunter-repo-'));
    cleanupPaths.push(repository);
    await fs.mkdir(path.join(repository, 'src'), { recursive: true });
    await fs.writeFile(path.join(repository, 'src', 'feature.ts'), 'export const enabled = false;\n');
    await fs.writeFile(path.join(repository, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
    await fs.writeFile(path.join(repository, '.env'), 'SECRET=never-copy-this\n');

    const database = new Database(':memory:');
    const app = await buildApp({ database });
    const project = database.raw.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string };
    database.raw.prepare('UPDATE projects SET local_repo_path = ? WHERE id = ?').run(repository, project.id);

    try {
      const createdResponse = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: {
          projectId: project.id,
          title: '更新 feature 开关',
          description: '把 feature 开关实现为可用状态，并给出验证结果。',
        },
      });
      expect(createdResponse.statusCode).toBe(201);
      let task = createdResponse.json<Task>();

      const analyzedResponse = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/analyze` });
      expect(analyzedResponse.statusCode).toBe(200);
      task = analyzedResponse.json<{ task: Task }>().task;
      expect(task.scope?.editablePaths).toContain('src/feature.ts');
      expect(task.scope?.deniedPaths).toContain('**/.env');

      const publishedResponse = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/publish`,
        payload: { rewardPoints: 100 },
      });
      expect(publishedResponse.statusCode).toBe(200);
      expect(publishedResponse.json<Task>().status).toBe('open');

      const developerLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/demo',
        payload: { login: 'lin.dev' },
      });
      const developerCookie = cookieFrom(developerLogin.headers);
      const beforePoints = (await app.inject({ method: 'GET', url: '/api/points', headers: { cookie: developerCookie } }))
        .json<{ available: number }>().available;

      const claimedResponse = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/claim`,
        headers: { cookie: developerCookie },
      });
      expect(claimedResponse.statusCode).toBe(200);
      expect(claimedResponse.json<Task>().assignee?.login).toBe('lin.dev');

      const workspaceResponse = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/workspaces`,
        headers: { cookie: developerCookie },
      });
      expect(workspaceResponse.statusCode).toBe(201);
      const workspace = workspaceResponse.json<Workspace>();
      expect(workspace.status).toBe('running');
      expect(workspace.packagePath).toBeTruthy();
      cleanupPaths.push(path.dirname(path.dirname(workspace.packagePath!)));

      await expect(fs.access(path.join(workspace.packagePath!, '.env'))).rejects.toThrow();
      await expect(fs.readFile(path.join(workspace.packagePath!, 'package.json'), 'utf8')).resolves.toContain('node --test');
      await fs.writeFile(path.join(workspace.packagePath!, 'src', 'feature.ts'), 'export const enabled = true;\n');

      const submitResponse = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/submissions`,
        headers: { cookie: developerCookie },
        payload: { summary: '启用 feature 开关。', testOutput: '1 test passed' },
      });
      expect(submitResponse.statusCode).toBe(201);
      const submission = submitResponse.json<Submission>();
      expect(submission.status).toBe('approved');
      expect(submission.review?.deliveryDocument).toContain('交付文档');

      const reviewerLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/demo',
        payload: { login: 'zhou.review' },
      });
      const reviewerCookie = cookieFrom(reviewerLogin.headers);
      const acceptedResponse = await app.inject({
        method: 'POST',
        url: `/api/submissions/${submission.id}/accept`,
        headers: { cookie: reviewerCookie },
      });
      expect(acceptedResponse.statusCode).toBe(200);
      expect(acceptedResponse.json<Task>().status).toBe('accepted');

      const afterPoints = (await app.inject({ method: 'GET', url: '/api/points', headers: { cookie: developerCookie } }))
        .json<{ available: number }>().available;
      expect(afterPoints - beforePoints).toBe(100);
    } finally {
      await app.close();
    }
  });

  it('allows only one concurrent claimant', async () => {
    const database = new Database(':memory:');
    const app = await buildApp({ database });
    try {
      const task = database.raw.prepare("SELECT id FROM tasks WHERE status = 'open' LIMIT 1").get() as { id: string };
      const developerCookie = cookieFrom((await app.inject({
        method: 'POST', url: '/api/auth/demo', payload: { login: 'lin.dev' },
      })).headers);
      const reviewerCookie = cookieFrom((await app.inject({
        method: 'POST', url: '/api/auth/demo', payload: { login: 'zhou.review' },
      })).headers);

      const responses = await Promise.all([
        app.inject({ method: 'POST', url: `/api/tasks/${task.id}/claim`, headers: { cookie: developerCookie } }),
        app.inject({ method: 'POST', url: `/api/tasks/${task.id}/claim`, headers: { cookie: reviewerCookie } }),
      ]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    } finally {
      await app.close();
    }
  });
});
