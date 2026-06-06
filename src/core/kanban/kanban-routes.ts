/**
 * @file kanban-routes.ts
 * @description REST routes for Kanban board and swarm orchestration.
 *
 * All routes are Bearer-gated using admin token.
 *
 * Routes:
 *   GET    /v1/admin/kanban/tasks                — list tasks
 *   POST   /v1/admin/kanban/tasks                — create task
 *   GET    /v1/admin/kanban/tasks/:id            — get task
 *   PATCH  /v1/admin/kanban/tasks/:id            — update task
 *   DELETE /v1/admin/kanban/tasks/:id            — delete task
 *   POST   /v1/admin/kanban/tasks/:id/move       — move task to new status
 *   POST   /v1/admin/kanban/swarm/decompose      — decompose task into workers
 *   POST   /v1/admin/kanban/swarm/execute        — spawn swarm for task
 *   GET    /v1/admin/kanban/dispatcher/state     — get dispatcher state & stats
 *   POST   /v1/admin/kanban/dispatcher/start     — start dispatcher daemon
 *   POST   /v1/admin/kanban/dispatcher/stop      — stop dispatcher daemon
 *   POST   /v1/admin/kanban/worker/heartbeat     — record worker heartbeat
 *   POST   /v1/admin/kanban/worker/complete      — record worker completion
 *   POST   /v1/admin/kanban/worker/block         — record worker blocked
 *
 * Kill-switch: SUDO_KANBAN_DISABLE=1 returns 503 on all routes.
 */

import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import { kanbanBoard } from './kanban-board.js';
import { swarmOrchestrator } from './swarm-orchestrator.js';
import { KanbanDispatcher } from './dispatcher.js';
import { WorkerProtocolManager } from './worker-protocol.js';
import { SwarmManager } from '../swarm/swarm-manager.js';
import type { KanbanStatus, KanbanWorkspace, KanbanPriority, SwarmWorkerSpec } from './kanban-types.js';
import type { WorkerHeartbeat, WorkerCompletion, WorkerBlock } from './worker-protocol.js';

// Lazy singletons — created on first access so config can be applied first.
let _swarmManager: SwarmManager | null = null;
let _dispatcher: KanbanDispatcher | null = null;
let _workerProtocol: WorkerProtocolManager | null = null;

function getSwarmManager(): SwarmManager {
  if (!_swarmManager) {
    _swarmManager = new SwarmManager('data/swarm.db');
  }
  return _swarmManager;
}

function getDispatcher(): KanbanDispatcher {
  if (!_dispatcher) {
    _dispatcher = new KanbanDispatcher(kanbanBoard, getSwarmManager());
  }
  return _dispatcher;
}

function getWorkerProtocol(): WorkerProtocolManager {
  if (!_workerProtocol) {
    _workerProtocol = new WorkerProtocolManager(getDispatcher());
  }
  return _workerProtocol;
}

const log = createLogger('gateway:kanban-routes');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BODY = 64 * 1024; // 64 KB
const KILL_SWITCH = 'SUDO_KANBAN_DISABLE';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isDisabled(): boolean {
  return process.env[KILL_SWITCH] === '1';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { ok: false, error: message });
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function extractBearer(req: IncomingMessage): string {
  const h = req.headers['authorization'] ?? '';
  if (typeof h !== 'string') return '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? (m[1] ?? '') : '';
}

function isAuthorised(req: IncomingMessage, adminTokenBuf: Buffer | null): boolean {
  if (adminTokenBuf === null) return true;
  const candidate = Buffer.from(extractBearer(req), 'utf8');
  return candidate.length === adminTokenBuf.length && timingSafeEqual(candidate, adminTokenBuf);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleListTasks(
  req: IncomingMessage,
  res: ServerResponse,
  adminTokenBuf: Buffer | null,
): void {
  if (!isAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  if (isDisabled()) {
    sendError(res, 503, 'Kanban disabled (SUDO_KANBAN_DISABLE=1)');
    return;
  }

  const urlObj = new URL(req.url ?? '/', 'http://localhost');
  const status = urlObj.searchParams.get('status') as KanbanStatus | null;
  const workspace = urlObj.searchParams.get('workspace') as KanbanWorkspace | null;
  const tenantId = urlObj.searchParams.get('tenantId');

  try {
    const tasks = kanbanBoard.listTasks({
      status: status ?? undefined,
      workspace: workspace ?? undefined,
      tenantId: tenantId ?? undefined,
    });
    sendJson(res, 200, { ok: true, data: { tasks, count: tasks.length } });
  } catch (err) {
    log.error({ err: String(err) }, 'handleListTasks failed');
    sendError(res, 500, 'Internal server error');
  }
}

async function handleCreateTask(
  req: IncomingMessage,
  res: ServerResponse,
  adminTokenBuf: Buffer | null,
): Promise<void> {
  if (!isAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  if (isDisabled()) {
    sendError(res, 503, 'Kanban disabled (SUDO_KANBAN_DISABLE=1)');
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendError(res, 400, 'Request body too large or unreadable');
    return;
  }

  if (!raw || raw.trim() === '') {
    sendError(res, 400, 'Request body is required');
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  const b = body as Record<string, unknown>;
  if (typeof b['title'] !== 'string' || b['title'].trim() === '') {
    sendError(res, 400, 'title is required and must be a non-empty string');
    return;
  }
  if (typeof b['body'] !== 'string') {
    sendError(res, 400, 'body is required and must be a string');
    return;
  }

  try {
    const task = kanbanBoard.createTask({
      title: b['title'] as string,
      body: b['body'] as string,
      status: (b['status'] as KanbanStatus) ?? 'todo',
      priority: ((b['priority'] as number) ?? 3) as 1 | 2 | 3 | 4 | 5,
      assignee: b['assignee'] as string | null,
      skills: Array.isArray(b['skills']) ? b['skills'] as string[] : [],
      parentId: b['parentId'] as string | null,
      workspace: (b['workspace'] as KanbanWorkspace) ?? 'scratch',
      tenantId: b['tenantId'] as string | null,
    });
    sendJson(res, 201, { ok: true, data: { task } });
    log.info({ taskId: task.id }, 'Task created via REST');
  } catch (err) {
    log.error({ err: String(err) }, 'handleCreateTask failed');
    sendError(res, 500, 'Internal server error');
  }
}

function handleGetTask(
  req: IncomingMessage,
  res: ServerResponse,
  adminTokenBuf: Buffer | null,
): void {
  if (!isAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  if (isDisabled()) {
    sendError(res, 503, 'Kanban disabled (SUDO_KANBAN_DISABLE=1)');
    return;
  }

  const pathname = (req.url ?? '/').split('?')[0] ?? '/';
  const parts = pathname.split('/');
  const id = parts[parts.length - 1];

  if (!id || id === '') {
    sendError(res, 400, 'Task ID is required');
    return;
  }

  try {
    const task = kanbanBoard.getTask(id);
    if (!task) {
      sendError(res, 404, 'Task not found');
      return;
    }
    sendJson(res, 200, { ok: true, data: { task } });
  } catch (err) {
    log.error({ err: String(err) }, 'handleGetTask failed');
    sendError(res, 500, 'Internal server error');
  }
}

async function handleUpdateTask(
  req: IncomingMessage,
  res: ServerResponse,
  adminTokenBuf: Buffer | null,
): Promise<void> {
  if (!isAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  if (isDisabled()) {
    sendError(res, 503, 'Kanban disabled (SUDO_KANBAN_DISABLE=1)');
    return;
  }

  const pathname = (req.url ?? '/').split('?')[0] ?? '/';
  const parts = pathname.split('/');
  const id = parts[parts.length - 1];

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendError(res, 400, 'Request body too large or unreadable');
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  const b = body as Record<string, unknown>;

  try {
    const updated = kanbanBoard.updateTask(id, {
      title: b['title'] as string | undefined,
      body: b['body'] as string | undefined,
      status: b['status'] as KanbanStatus | undefined,
      priority: b['priority'] as KanbanPriority | undefined,
      assignee: b['assignee'] as string | undefined,
      skills: b['skills'] as string[] | undefined,
      parentId: b['parentId'] as string | undefined,
      workspace: b['workspace'] as KanbanWorkspace | undefined,
      tenantId: b['tenantId'] as string | undefined,
    });
    if (!updated) {
      sendError(res, 404, 'Task not found');
      return;
    }
    const task = kanbanBoard.getTask(id);
    sendJson(res, 200, { ok: true, data: { task } });
  } catch (err) {
    log.error({ err: String(err) }, 'handleUpdateTask failed');
    sendError(res, 500, 'Internal server error');
  }
}

function handleDeleteTask(
  req: IncomingMessage,
  res: ServerResponse,
  adminTokenBuf: Buffer | null,
): void {
  if (!isAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  if (isDisabled()) {
    sendError(res, 503, 'Kanban disabled (SUDO_KANBAN_DISABLE=1)');
    return;
  }

  const pathname = (req.url ?? '/').split('?')[0] ?? '/';
  const parts = pathname.split('/');
  const id = parts[parts.length - 1];

  if (!id || id === '') {
    sendError(res, 400, 'Task ID is required');
    return;
  }

  try {
    const deleted = kanbanBoard.deleteTask(id);
    if (!deleted) {
      sendError(res, 404, 'Task not found');
      return;
    }
    sendJson(res, 200, { ok: true, data: { deleted: true } });
  } catch (err) {
    log.error({ err: String(err) }, 'handleDeleteTask failed');
    sendError(res, 500, 'Internal server error');
  }
}

async function handleMoveTask(
  req: IncomingMessage,
  res: ServerResponse,
  adminTokenBuf: Buffer | null,
): Promise<void> {
  if (!isAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  if (isDisabled()) {
    sendError(res, 503, 'Kanban disabled (SUDO_KANBAN_DISABLE=1)');
    return;
  }

  const pathname = (req.url ?? '/').split('?')[0] ?? '/';
  const parts = pathname.split('/');
  const id = parts[parts.length - 2]; // /:id/move

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendError(res, 400, 'Request body too large or unreadable');
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  const b = body as Record<string, unknown>;
  const newStatus = b['status'] as KanbanStatus;

  if (!newStatus || !['todo', 'in_progress', 'review', 'done'].includes(newStatus)) {
    sendError(res, 400, 'status must be one of: todo, in_progress, review, done');
    return;
  }

  try {
    const moved = kanbanBoard.moveTask(id, newStatus);
    if (!moved) {
      sendError(res, 400, 'Invalid status transition or task not found');
      return;
    }
    const task = kanbanBoard.getTask(id);
    sendJson(res, 200, { ok: true, data: { task } });
  } catch (err) {
    log.error({ err: String(err) }, 'handleMoveTask failed');
    sendError(res, 500, 'Internal server error');
  }
}

async function handleDecompose(
  req: IncomingMessage,
  res: ServerResponse,
  adminTokenBuf: Buffer | null,
): Promise<void> {
  if (!isAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  if (isDisabled()) {
    sendError(res, 503, 'Kanban disabled (SUDO_KANBAN_DISABLE=1)');
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendError(res, 400, 'Request body too large or unreadable');
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  const b = body as Record<string, unknown>;
  const taskId = b['taskId'] as string | undefined;

  if (!taskId) {
    sendError(res, 400, 'taskId is required');
    return;
  }

  try {
    const task = kanbanBoard.getTask(taskId);
    if (!task) {
      sendError(res, 404, 'Task not found');
      return;
    }

    const workers = swarmOrchestrator.decompose(task);
    sendJson(res, 200, { ok: true, data: { taskId, workers } });
    log.info({ taskId, workerCount: workers.length }, 'Task decomposed');
  } catch (err) {
    log.error({ err: String(err) }, 'handleDecompose failed');
    sendError(res, 500, 'Internal server error');
  }
}

async function handleExecuteSwarm(
  req: IncomingMessage,
  res: ServerResponse,
  adminTokenBuf: Buffer | null,
): Promise<void> {
  if (!isAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  if (isDisabled()) {
    sendError(res, 503, 'Kanban disabled (SUDO_KANBAN_DISABLE=1)');
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendError(res, 400, 'Request body too large or unreadable');
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  const b = body as Record<string, unknown>;
  const taskId = b['taskId'] as string | undefined;

  if (!taskId) {
    sendError(res, 400, 'taskId is required');
    return;
  }

  try {
    const task = kanbanBoard.getTask(taskId);
    if (!task) {
      sendError(res, 404, 'Task not found');
      return;
    }

    const workers = swarmOrchestrator.decompose(task);
    const swarm = await swarmOrchestrator.spawnSwarm(workers, taskId);

    sendJson(res, 202, {
      ok: true,
      data: {
        swarmId: swarm.swarmId,
        status: swarm.status,
        workerCount: swarm.workerIds.length,
      },
    });
    log.info({ swarmId: swarm.swarmId, taskId }, 'Swarm execution started');
  } catch (err) {
    log.error({ err: String(err) }, 'handleExecuteSwarm failed');
    sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Phase 5: Dispatcher & Worker Protocol handlers
// ---------------------------------------------------------------------------

function handleDispatcherState(
  req: IncomingMessage,
  res: ServerResponse,
  adminTokenBuf: Buffer | null,
): void {
  if (!isAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  if (isDisabled()) {
    sendError(res, 503, 'Kanban disabled (SUDO_KANBAN_DISABLE=1)');
    return;
  }

  try {
    const dispatcher = getDispatcher();
    const state = dispatcher.getState();
    const stats = dispatcher.getStats();
    sendJson(res, 200, { ok: true, data: { state, stats } });
  } catch (err) {
    log.error({ err: String(err) }, 'handleDispatcherState failed');
    sendError(res, 500, 'Internal server error');
  }
}

function handleDispatcherStart(
  req: IncomingMessage,
  res: ServerResponse,
  adminTokenBuf: Buffer | null,
): void {
  if (!isAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  if (isDisabled()) {
    sendError(res, 503, 'Kanban disabled (SUDO_KANBAN_DISABLE=1)');
    return;
  }

  try {
    const dispatcher = getDispatcher();
    dispatcher.start();
    sendJson(res, 200, { ok: true, data: { state: dispatcher.getState() } });
    log.info('Dispatcher started via REST');
  } catch (err) {
    log.error({ err: String(err) }, 'handleDispatcherStart failed');
    sendError(res, 500, 'Internal server error');
  }
}

function handleDispatcherStop(
  req: IncomingMessage,
  res: ServerResponse,
  adminTokenBuf: Buffer | null,
): void {
  if (!isAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  if (isDisabled()) {
    sendError(res, 503, 'Kanban disabled (SUDO_KANBAN_DISABLE=1)');
    return;
  }

  try {
    const dispatcher = getDispatcher();
    dispatcher.stop();
    sendJson(res, 200, { ok: true, data: { state: dispatcher.getState() } });
    log.info('Dispatcher stopped via REST');
  } catch (err) {
    log.error({ err: String(err) }, 'handleDispatcherStop failed');
    sendError(res, 500, 'Internal server error');
  }
}

async function handleWorkerHeartbeat(
  req: IncomingMessage,
  res: ServerResponse,
  adminTokenBuf: Buffer | null,
): Promise<void> {
  if (!isAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  if (isDisabled()) {
    sendError(res, 503, 'Kanban disabled (SUDO_KANBAN_DISABLE=1)');
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendError(res, 400, 'Request body too large or unreadable');
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  const b = body as Record<string, unknown>;
  if (typeof b['workerId'] !== 'string' || typeof b['taskId'] !== 'string') {
    sendError(res, 400, 'workerId and taskId are required strings');
    return;
  }

  try {
    const proto = getWorkerProtocol();
    const heartbeat: WorkerHeartbeat = {
      workerId: b['workerId'] as string,
      taskId: b['taskId'] as string,
      progress: typeof b['progress'] === 'number' ? b['progress'] : 0,
      timestamp: (b['timestamp'] as string) ?? new Date().toISOString(),
    };
    proto.heartbeat(heartbeat);
    sendJson(res, 200, { ok: true, data: { acknowledged: true } });
  } catch (err) {
    log.error({ err: String(err) }, 'handleWorkerHeartbeat failed');
    sendError(res, 500, 'Internal server error');
  }
}

async function handleWorkerComplete(
  req: IncomingMessage,
  res: ServerResponse,
  adminTokenBuf: Buffer | null,
): Promise<void> {
  if (!isAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  if (isDisabled()) {
    sendError(res, 503, 'Kanban disabled (SUDO_KANBAN_DISABLE=1)');
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendError(res, 400, 'Request body too large or unreadable');
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  const b = body as Record<string, unknown>;
  if (typeof b['workerId'] !== 'string' || typeof b['taskId'] !== 'string') {
    sendError(res, 400, 'workerId and taskId are required strings');
    return;
  }

  try {
    const proto = getWorkerProtocol();
    const completion: WorkerCompletion = {
      workerId: b['workerId'] as string,
      taskId: b['taskId'] as string,
      result: (b['result'] as string) ?? '',
      durationMs: typeof b['durationMs'] === 'number' ? b['durationMs'] : 0,
      success: b['success'] !== false,
    };
    proto.complete(completion);
    sendJson(res, 200, { ok: true, data: { acknowledged: true } });
  } catch (err) {
    log.error({ err: String(err) }, 'handleWorkerComplete failed');
    sendError(res, 500, 'Internal server error');
  }
}

async function handleWorkerBlock(
  req: IncomingMessage,
  res: ServerResponse,
  adminTokenBuf: Buffer | null,
): Promise<void> {
  if (!isAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  if (isDisabled()) {
    sendError(res, 503, 'Kanban disabled (SUDO_KANBAN_DISABLE=1)');
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendError(res, 400, 'Request body too large or unreadable');
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  const b = body as Record<string, unknown>;
  if (typeof b['workerId'] !== 'string' || typeof b['taskId'] !== 'string') {
    sendError(res, 400, 'workerId and taskId are required strings');
    return;
  }

  try {
    const proto = getWorkerProtocol();
    const block: WorkerBlock = {
      workerId: b['workerId'] as string,
      taskId: b['taskId'] as string,
      reason: (b['reason'] as string) ?? 'unknown',
      requiresHumanAttention: b['needsHuman'] === true,
    };
    proto.block(block);
    sendJson(res, 200, { ok: true, data: { acknowledged: true } });
  } catch (err) {
    log.error({ err: String(err) }, 'handleWorkerBlock failed');
    sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Attach kanban routes to the provided http.Server.
 */
export function registerKanbanRoutes(
  server: HttpServer,
  adminTokenBuf: Buffer | null,
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? '';
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';

    if (!pathname.startsWith('/v1/admin/kanban/')) return;

    // GET /v1/admin/kanban/tasks
    if (method === 'GET' && pathname === '/v1/admin/kanban/tasks') {
      handleListTasks(req, res, adminTokenBuf);
      return;
    }

    // POST /v1/admin/kanban/tasks
    if (method === 'POST' && pathname === '/v1/admin/kanban/tasks') {
      handleCreateTask(req, res, adminTokenBuf).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Unhandled error in create');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // GET /v1/admin/kanban/tasks/:id
    if (method === 'GET' && /^\/v1\/admin\/kanban\/tasks\/[^/]+$/.test(pathname)) {
      handleGetTask(req, res, adminTokenBuf);
      return;
    }

    // PATCH /v1/admin/kanban/tasks/:id
    if (method === 'PATCH' && /^\/v1\/admin\/kanban\/tasks\/[^/]+$/.test(pathname)) {
      handleUpdateTask(req, res, adminTokenBuf).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Unhandled error in update');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // DELETE /v1/admin/kanban/tasks/:id
    if (method === 'DELETE' && /^\/v1\/admin\/kanban\/tasks\/[^/]+$/.test(pathname)) {
      handleDeleteTask(req, res, adminTokenBuf);
      return;
    }

    // POST /v1/admin/kanban/tasks/:id/move
    if (method === 'POST' && /^\/v1\/admin\/kanban\/tasks\/[^/]+\/move$/.test(pathname)) {
      handleMoveTask(req, res, adminTokenBuf).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Unhandled error in move');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // POST /v1/admin/kanban/swarm/decompose
    if (method === 'POST' && pathname === '/v1/admin/kanban/swarm/decompose') {
      handleDecompose(req, res, adminTokenBuf).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Unhandled error in decompose');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // POST /v1/admin/kanban/swarm/execute
    if (method === 'POST' && pathname === '/v1/admin/kanban/swarm/execute') {
      handleExecuteSwarm(req, res, adminTokenBuf).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Unhandled error in execute');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // GET /v1/admin/kanban/dispatcher/state
    if (method === 'GET' && pathname === '/v1/admin/kanban/dispatcher/state') {
      handleDispatcherState(req, res, adminTokenBuf);
      return;
    }

    // POST /v1/admin/kanban/dispatcher/start
    if (method === 'POST' && pathname === '/v1/admin/kanban/dispatcher/start') {
      handleDispatcherStart(req, res, adminTokenBuf);
      return;
    }

    // POST /v1/admin/kanban/dispatcher/stop
    if (method === 'POST' && pathname === '/v1/admin/kanban/dispatcher/stop') {
      handleDispatcherStop(req, res, adminTokenBuf);
      return;
    }

    // POST /v1/admin/kanban/worker/heartbeat
    if (method === 'POST' && pathname === '/v1/admin/kanban/worker/heartbeat') {
      handleWorkerHeartbeat(req, res, adminTokenBuf).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Unhandled error in worker heartbeat');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // POST /v1/admin/kanban/worker/complete
    if (method === 'POST' && pathname === '/v1/admin/kanban/worker/complete') {
      handleWorkerComplete(req, res, adminTokenBuf).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Unhandled error in worker complete');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // POST /v1/admin/kanban/worker/block
    if (method === 'POST' && pathname === '/v1/admin/kanban/worker/block') {
      handleWorkerBlock(req, res, adminTokenBuf).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Unhandled error in worker block');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // Unmatched /v1/admin/kanban/* path
    sendError(res, 404, 'Not found');
  });

  log.info('Kanban routes registered');
}
