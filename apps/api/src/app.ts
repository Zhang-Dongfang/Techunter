import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import rawBody from 'fastify-raw-body';
import { z, ZodError } from 'zod';
import { AgentService } from './agent-service.js';
import { AssistantService } from './assistant-service.js';
import { assertRole, registerAuth } from './auth.js';
import { config } from './config.js';
import { database } from './database.js';
import { httpError } from './errors.js';
import { GitHubService } from './github-service.js';
import { desktopCorsMethods } from './http-policy.js';
import { TaskService } from './task-service.js';
import { canReviewScope, ScopeRequestService } from './scope-request-service.js';

const idParams = z.object({ id: z.string().uuid() });
const scopeRequestParams = idParams.extend({ requestId: z.string().uuid() });
const createTaskBody = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(10).max(20_000),
  parentTaskId: z.string().uuid().nullable().optional(),
});
const publishBody = z.object({ rewardPoints: z.number().int().min(1).max(100_000).optional() });
const importProjectBody = z.object({ githubRepositoryId: z.number().int().positive() });
const switchProjectBranchBody = z.object({ sourceBranch: z.string().trim().min(1).max(255) });
const workspaceBody = z.object({ deviceId: z.string().trim().min(8).max(200), deviceLabel: z.string().trim().min(1).max(200) });
const workspaceUpdateBody = z.object({
  status: z.enum(['provisioning', 'running', 'failed']),
  headSha: z.string().max(100).optional(),
  setupLog: z.string().max(100_000).optional(),
  error: z.string().max(10_000).nullable().optional(),
});
const packageFile = z.object({ path: z.string().min(1).max(2_000), content: z.string().nullable(), encoding: z.enum(['utf-8', 'base64']) });
const submitBody = z.object({
  summary: z.string().trim().min(3).max(10_000),
  testOutput: z.string().max(100_000).default(''),
  files: z.array(packageFile).max(1_000),
});
const changesBody = z.object({ reason: z.string().trim().min(3).max(5_000) });
const assistantBody = z.object({
  message: z.string().trim().min(1).max(10_000),
  projectId: z.string().uuid().optional(),
  deviceId: z.string().max(200).optional(),
  deviceLabel: z.string().max(200).optional(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(20_000) })).max(20).default([]),
});

function verifyWebhook(raw: string, signature: string | undefined): boolean {
  const secret = config().github.webhookSecret;
  if (!secret || !signature?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function buildApp() {
  const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024, trustProxy: true });
  const github = new GitHubService();
  const agent = new AgentService(github);
  const tasks = new TaskService(github, agent);
  const scopeRequests = new ScopeRequestService(tasks);
  const assistant = new AssistantService(tasks, github);

  await app.register(cookie);
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || config().webOrigins.includes(origin.replace(/\/+$/, '')) || origin === config().publicUrl) callback(null, true);
      else callback(new Error('Origin is not allowed'), false);
    },
    credentials: true,
    methods: desktopCorsMethods,
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(rawBody, { field: 'rawBody', global: false, encoding: 'utf8', runFirst: true });

  app.get('/health', async () => ({ ok: true, service: 'techunter-api', version: '0.1.0', github: github.configured, agent: agent.configured }));
  registerAuth(app);

  app.get('/api/dashboard', async (request) => ({
    ...await tasks.dashboard(request.currentUser),
    runtime: {
      agentConfigured: agent.configured && (config().ai.accessMode === 'direct' || Boolean(request.modelAuthorization)),
      agentModel: config().ai.model || null,
      githubConfigured: github.configured,
      githubAccountLinkConfigured: Boolean(config().github.clientId),
      githubConnected: request.githubConnected,
      modelAccessMode: config().ai.accessMode,
      conexusAuthorizationRequired: config().ai.accessMode === 'conexus' && !request.modelAuthorization,
      modelAuthorizationExpiresAt: request.modelAuthorizationExpiresAt ?? null,
    },
  }));

  app.get('/api/projects', async () => ({ projects: await tasks.projects() }));
  app.get('/api/github/repositories', async (request) => {
    if (!request.githubCredential) throw httpError('请先连接 GitHub 账号。', 401, 'GITHUB_ACCOUNT_REQUIRED');
    const projects = await tasks.projects();
    return { repositories: await github.listRepositories(request.githubCredential, new Set(projects.map((project) => project.githubRepositoryId))) };
  });
  app.post('/api/projects/import', async (request, reply) => {
    if (!request.githubCredential) throw httpError('请先连接 GitHub 账号。', 401, 'GITHUB_ACCOUNT_REQUIRED');
    const repository = await github.repository(importProjectBody.parse(request.body).githubRepositoryId, request.githubCredential);
    return reply.code(201).send(await tasks.importProject(repository, request.currentUser));
  });
  app.get('/api/projects/:id/branches', async (request) => {
    if (!request.githubCredential) throw httpError('请先连接 GitHub 账号。', 401, 'GITHUB_ACCOUNT_REQUIRED');
    return tasks.projectBranches(idParams.parse(request.params).id, request.githubCredential);
  });
  app.patch('/api/projects/:id/branch', async (request) => {
    if (!request.githubCredential) throw httpError('请先连接 GitHub 账号。', 401, 'GITHUB_ACCOUNT_REQUIRED');
    assertRole(request, ['admin', 'maintainer']);
    const projectId = idParams.parse(request.params).id;
    return tasks.switchProjectBranch(projectId, switchProjectBranchBody.parse(request.body).sourceBranch, request.currentUser, request.githubCredential);
  });
  app.get('/api/projects/:id/checkout-authorization', async (request) => {
    if (!request.githubCredential) throw httpError('请先连接 GitHub 账号。', 401, 'GITHUB_ACCOUNT_REQUIRED');
    const project = await tasks.getProject(idParams.parse(request.params).id);
    return github.checkoutAuthorization(project, request.githubCredential);
  });
  app.post('/api/projects/:id/collaboration-request', async (request) => {
    if (!request.githubCredential) throw httpError('提交合作者申请前请先连接 GitHub 账号。', 401, 'GITHUB_ACCOUNT_REQUIRED');
    return tasks.requestProjectCollaboration(idParams.parse(request.params).id, request.currentUser, request.githubCredential);
  });

  app.get('/api/tasks', async (request) => {
    const query = request.query as { status?: string; mine?: string; search?: string };
    return { tasks: await tasks.listTasks({ status: query.status, assigneeId: query.mine === 'true' ? request.currentUser.id : undefined, search: query.search }) };
  });
  app.get('/api/tasks/:id', async (request) => tasks.getTask(idParams.parse(request.params).id));
  app.get('/api/tasks/:id/scope-requests', async (request) => ({ requests: await scopeRequests.list(idParams.parse(request.params).id, request.currentUser) }));
  app.post('/api/tasks/:id/scope-requests', async (request, reply) => reply.code(201).send(
    await scopeRequests.create(idParams.parse(request.params).id, request.currentUser, request.body as Parameters<ScopeRequestService['create']>[2]),
  ));
  app.post('/api/tasks/:id/scope-requests/:requestId/decision', async (request) => {
    const { id, requestId } = scopeRequestParams.parse(request.params);
    const decision = await scopeRequests.decide(id, requestId, request.currentUser, request.body as Parameters<ScopeRequestService['decide']>[3]);
    const task = await tasks.getTask(id);
    let githubSynced: boolean | null = null;
    if (decision.approvedPaths.length) {
      try { await github.syncTaskScope(task, await tasks.getProject(task.projectId), request.githubCredential); githubSynced = true; }
      catch { githubSynced = false; } // A transport failure must not undo or duplicate an atomic decision.
    }
    return { request: decision, task, githubSynced };
  });
  app.post('/api/tasks/:id/scope-requests/:requestId/withdraw', async (request) => {
    const { id, requestId } = scopeRequestParams.parse(request.params);
    return scopeRequests.withdraw(id, requestId, request.currentUser);
  });
  app.post('/api/tasks/:id/scope/sync', async (request) => {
    const task = await tasks.getTask(idParams.parse(request.params).id);
    if (!canReviewScope(task, request.currentUser)) throw httpError('只有任务发布者或管理员可以同步范围。', 403);
    await github.syncTaskScope(task, await tasks.getProject(task.projectId), request.githubCredential);
    return { synced: true };
  });
  app.delete('/api/tasks/:id', async (request) => {
    assertRole(request, ['admin']);
    return tasks.removeTask(idParams.parse(request.params).id, request.currentUser, request.githubCredential);
  });
  app.post('/api/tasks', async (request, reply) => {
    const body = createTaskBody.parse(request.body);
    if (!request.githubCredential) throw httpError('创建任务前请先连接 GitHub 账号。', 401, 'GITHUB_ACCOUNT_REQUIRED');
    await tasks.syncProject(body.projectId, request.currentUser, request.githubCredential);
    return reply.code(201).send(await tasks.createDraft({ ...body, publisherId: request.currentUser.id }, request.githubCredential));
  });
  app.post('/api/tasks/:id/analyze', async (request) => {
    if (config().ai.accessMode === 'conexus' && !request.modelAuthorization) {
      throw httpError('Conexus 模型授权已过期，请重新授权。', 401, 'CONEXUS_AUTHORIZATION_REQUIRED');
    }
    const { id } = idParams.parse(request.params);
    const analysis = await tasks.analyzeTask(id, request.currentUser, request.modelAuthorization, request.githubCredential);
    return { analysis, task: await tasks.getTask(id) };
  });
  app.post('/api/tasks/:id/publish', async (request) => {
    const { id } = idParams.parse(request.params);
    return tasks.publishTask(id, request.currentUser, publishBody.parse(request.body ?? {}).rewardPoints, request.githubCredential);
  });
  app.post('/api/tasks/:id/claim', async (request) => tasks.claimTask(idParams.parse(request.params).id, request.currentUser, request.githubCredential));
  app.post('/api/tasks/:id/release', async (request) => tasks.releaseTask(idParams.parse(request.params).id, request.currentUser, request.githubCredential));
  app.post('/api/tasks/:id/subtasks', async (request, reply) => {
    const parentId = idParams.parse(request.params).id;
    const body = createTaskBody.omit({ parentTaskId: true }).parse(request.body);
    if (!request.githubCredential) throw httpError('创建子任务前请先连接 GitHub 账号。', 401, 'GITHUB_ACCOUNT_REQUIRED');
    await tasks.syncProject(body.projectId, request.currentUser, request.githubCredential);
    return reply.code(201).send(await tasks.createDraft({ ...body, parentTaskId: parentId, publisherId: request.currentUser.id }, request.githubCredential));
  });
  app.post('/api/tasks/:id/workspaces', async (request, reply) => reply.code(201).send(await tasks.createWorkspace(idParams.parse(request.params).id, request.currentUser, workspaceBody.parse(request.body))));
  app.patch('/api/workspaces/:id', async (request) => tasks.updateWorkspace(idParams.parse(request.params).id, request.currentUser, workspaceUpdateBody.parse(request.body)));
  app.post('/api/tasks/:id/submissions', async (request, reply) => {
    if (config().ai.accessMode === 'conexus' && !request.modelAuthorization) {
      throw httpError('Conexus 模型授权已过期，请重新授权。', 401, 'CONEXUS_AUTHORIZATION_REQUIRED');
    }
    return reply.code(201).send(await tasks.submitTask(idParams.parse(request.params).id, request.currentUser, submitBody.parse(request.body), request.modelAuthorization, request.githubCredential));
  });
  app.post('/api/submissions/:id/accept', async (request) => {
    assertRole(request, ['admin', 'maintainer']);
    return tasks.acceptSubmission(idParams.parse(request.params).id, request.currentUser, request.githubCredential);
  });
  app.post('/api/submissions/:id/request-changes', async (request) => {
    assertRole(request, ['admin', 'maintainer']);
    return tasks.requestChanges(idParams.parse(request.params).id, request.currentUser, changesBody.parse(request.body).reason, request.githubCredential);
  });
  app.get('/api/points', async (request) => tasks.points(request.currentUser.id));
  app.get('/api/audit', async (request) => {
    assertRole(request, ['admin', 'maintainer']);
    return { events: await tasks.auditEvents() };
  });
  app.post('/api/agent/chat', async (request) => {
    const body = assistantBody.parse(request.body);
    return assistant.chat({ ...body, user: request.currentUser, modelCredential: request.modelAuthorization?.credential, modelAudience: request.modelAuthorization?.audience, githubCredential: request.githubCredential });
  });

  app.post('/api/github/webhook', { config: { rawBody: true } }, async (request, reply) => {
    const raw = (request as typeof request & { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {});
    if (!verifyWebhook(raw, request.headers['x-hub-signature-256'] as string | undefined)) return reply.code(401).send({ error: 'GitHub Webhook 签名无效。' });
    const deliveryId = String(request.headers['x-github-delivery'] ?? '');
    const eventName = String(request.headers['x-github-event'] ?? 'unknown');
    if (!deliveryId) return reply.code(400).send({ error: '缺少 GitHub delivery ID。' });
    const insert = await database().from('github_deliveries').upsert({ delivery_id: deliveryId, event_name: eventName, payload_hash: createHash('sha256').update(raw).digest('hex') }, { onConflict: 'delivery_id', ignoreDuplicates: true });
    if (insert.error) throw new Error(insert.error.message);
    return { ok: true };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: error.issues[0]?.message ?? '请求参数无效。', code: 'VALIDATION_ERROR' });
    const caught = error instanceof Error ? error : new Error(String(error));
    const statusCode = 'statusCode' in caught && typeof caught.statusCode === 'number' ? caught.statusCode : 500;
    if (statusCode >= 500) app.log.error(caught);
    const code = 'code' in caught && typeof caught.code === 'string' ? caught.code : undefined;
    return reply.code(statusCode).send({ error: caught.message || '服务器内部错误。', ...(code ? { code } : {}) });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: '接口不存在。' }));
  return app;
}
