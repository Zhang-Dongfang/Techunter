import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import rawBody from 'fastify-raw-body';
import { z, ZodError } from 'zod';
import { AgentService } from './agent-service.js';
import { registerAuth, assertRole } from './auth.js';
import { config } from './config.js';
import { Database, seedDemo } from './database.js';
import { GitHubService } from './github-service.js';
import { LedgerService } from './ledger.js';
import { TaskService } from './task-service.js';
import { WorkspaceService } from './workspace-service.js';

const idParams = z.object({ id: z.string().uuid() });
const createTaskBody = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(10).max(20_000),
  parentTaskId: z.string().uuid().nullable().optional(),
});
const publishBody = z.object({ rewardPoints: z.number().int().min(1).max(100_000).optional() });
const submitBody = z.object({
  summary: z.string().trim().min(3).max(10_000),
  testOutput: z.string().max(100_000).default(''),
});
const changesBody = z.object({ reason: z.string().trim().min(3).max(5000) });

function verifyWebhook(raw: string, signature: string | undefined): boolean {
  if (!config.github.webhookSecret) return config.demoMode;
  if (!signature?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', config.github.webhookSecret).update(raw).digest('hex')}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function buildApp(options: { database?: Database } = {}) {
  const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });
  const database = options.database ?? new Database();
  const seed = seedDemo(database);
  const ledger = new LedgerService(database);
  const github = new GitHubService();
  const workspace = new WorkspaceService();
  const tasks = new TaskService(database, ledger, new AgentService(), github, workspace);

  await app.register(cookie);
  await app.register(cors, {
    origin(origin, callback) {
      const allowedOrigins = [config.webUrl, config.publicUrl].map((value) => {
        try { return new URL(value).origin; } catch { return value; }
      });
      if (!origin || allowedOrigins.includes(origin) || origin.startsWith('file://')) callback(null, true);
      else callback(new Error('Origin is not allowed'), false);
    },
    credentials: true,
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; " +
      "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://github.com",
    );
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });
  await app.register(rawBody, { field: 'rawBody', global: false, encoding: 'utf8', runFirst: true });

  app.get('/health', async () => ({ ok: true, version: '0.1.0', github: github.configured, demoMode: config.demoMode }));
  registerAuth(app, database, seed.adminId);

  app.get('/api/dashboard', async (request) => tasks.dashboard(request.currentUser));
  app.get('/api/projects', async () => ({ projects: tasks.projects() }));
  app.get('/api/tasks', async (request) => {
    const query = request.query as { status?: string; mine?: string; search?: string };
    return {
      tasks: tasks.listTasks({
        status: query.status,
        assigneeId: query.mine === 'true' ? request.currentUser.id : undefined,
        search: query.search,
      }),
    };
  });
  app.get('/api/tasks/:id', async (request) => tasks.getTask(idParams.parse(request.params).id));
  app.post('/api/tasks', async (request, reply) => {
    const body = createTaskBody.parse(request.body);
    const task = await tasks.createDraft({ ...body, publisherId: request.currentUser.id });
    return reply.code(201).send(task);
  });
  app.post('/api/tasks/:id/analyze', async (request) => {
    const { id } = idParams.parse(request.params);
    const analysis = await tasks.analyzeTask(id, request.currentUser.id);
    return { analysis, task: tasks.getTask(id) };
  });
  app.post('/api/tasks/:id/publish', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = publishBody.parse(request.body ?? {});
    return tasks.publishTask(id, request.currentUser.id, body.rewardPoints);
  });
  app.post('/api/tasks/:id/claim', async (request) => tasks.claimTask(idParams.parse(request.params).id, request.currentUser));
  app.post('/api/tasks/:id/release', async (request) => tasks.releaseTask(idParams.parse(request.params).id, request.currentUser));
  app.post('/api/tasks/:id/subtasks', async (request, reply) => {
    const parentId = idParams.parse(request.params).id;
    const body = createTaskBody.omit({ parentTaskId: true }).parse(request.body);
    const task = await tasks.createDraft({ ...body, parentTaskId: parentId, publisherId: request.currentUser.id });
    return reply.code(201).send(task);
  });
  app.post('/api/tasks/:id/workspaces', async (request, reply) => {
    const result = await tasks.createWorkspace(idParams.parse(request.params).id, request.currentUser);
    return reply.code(201).send(result);
  });
  app.post('/api/tasks/:id/submissions', async (request, reply) => {
    const body = submitBody.parse(request.body);
    const submission = await tasks.submitTask(idParams.parse(request.params).id, request.currentUser, body);
    return reply.code(201).send(submission);
  });
  app.post('/api/submissions/:id/accept', async (request) => {
    assertRole(request, ['admin', 'maintainer']);
    return tasks.acceptSubmission(idParams.parse(request.params).id, request.currentUser);
  });
  app.post('/api/submissions/:id/request-changes', async (request) => {
    assertRole(request, ['admin', 'maintainer']);
    const body = changesBody.parse(request.body);
    return tasks.requestChanges(idParams.parse(request.params).id, request.currentUser, body.reason);
  });
  app.get('/api/points', async (request) => ({
    available: ledger.balance('user', request.currentUser.id),
    reserved: ledger.balance('user', request.currentUser.id, 'reserved'),
    entries: ledger.listForUser(request.currentUser.id),
  }));
  app.get('/api/audit', async (request) => {
    assertRole(request, ['admin', 'maintainer']);
    const rows = database.raw.prepare(`
      SELECT a.*, u.login AS actor_login FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC LIMIT 200
    `).all();
    return { events: rows };
  });

  app.post('/api/github/webhook', { config: { rawBody: true } }, async (request, reply) => {
    const raw = (request as typeof request & { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {});
    if (!verifyWebhook(raw, request.headers['x-hub-signature-256'] as string | undefined)) {
      return reply.code(401).send({ error: 'GitHub Webhook 签名无效。' });
    }
    const deliveryId = String(request.headers['x-github-delivery'] ?? '');
    const eventName = String(request.headers['x-github-event'] ?? 'unknown');
    if (!deliveryId) return reply.code(400).send({ error: '缺少 GitHub delivery ID。' });
    const seen = database.raw.prepare('SELECT delivery_id FROM github_deliveries WHERE delivery_id = ?').get(deliveryId);
    if (seen) return { ok: true, duplicate: true };
    database.raw.prepare(
      'INSERT INTO github_deliveries (delivery_id, event_name, payload_hash, processed_at) VALUES (?, ?, ?, ?)'
    ).run(deliveryId, eventName, createHash('sha256').update(raw).digest('hex'), new Date().toISOString());
    database.audit(null, `github.${eventName}`, 'github_delivery', deliveryId, {
      action: (request.body as { action?: string } | null)?.action,
    });
    return { ok: true };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: error.issues[0]?.message ?? '请求参数无效。', code: 'VALIDATION_ERROR' });
    }
    const caught = error instanceof Error ? error : new Error(String(error));
    const statusCode = 'statusCode' in caught && typeof caught.statusCode === 'number' ? caught.statusCode : 500;
    if (statusCode >= 500) app.log.error(caught);
    return reply.code(statusCode).send({ error: caught.message || '服务器内部错误。' });
  });

  const webRoot = path.resolve(process.cwd(), 'dist/web');
  if (fs.existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: '接口不存在。' });
    });
  }

  app.addHook('onClose', async () => database.close());
  return app;
}
