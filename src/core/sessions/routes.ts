/**
 * @file routes.ts
 * @description REST endpoints mirroring Anthropic's /v1/sessions API.
 *
 * Endpoints:
 *   POST   /v1/sessions              — create session
 *   GET    /v1/sessions              — list (filter by status/userId/platform)
 *   GET    /v1/sessions/:id          — retrieve (includes status + message count)
 *   POST   /v1/sessions/:id          — update (title, metadata/status)
 *   POST   /v1/sessions/:id/archive  — archive (preserves history)
 *   DELETE /v1/sessions/:id          — hard delete (only if not running)
 *   POST   /v1/sessions/:id/interrupt — force state to idle
 *
 * Auth: GATEWAY_TOKEN bearer token (timing-safe comparison).
 *       All /v1/sessions/* routes require auth when GATEWAY_TOKEN is set.
 *
 * Errors:
 *   400 — invalid params
 *   401 — unauthorized
 *   404 — session not found
 *   409 — invalid state transition (SessionStateError)
 *   500 — internal server error
 */

import { timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import type { Database } from 'better-sqlite3';
import { SqliteSessionStore } from './sqlite-session-store.js';
import { SessionStateMachine, SessionStateError } from './state-machine.js';
import type { SessionStatus } from './state-machine.js';
import { genId } from '../shared/utils.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('sessions:routes');

const MAX_BODY = 128 * 1024; // 128 KB

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface SessionRouteDeps {
  store: SqliteSessionStore;
  stateMachine: SessionStateMachine;
}

// ---------------------------------------------------------------------------
// Auth helpers (self-contained — do not import from http-api.ts)
// ---------------------------------------------------------------------------

function getTokenBuf(): Buffer | null {
  const t = process.env['GATEWAY_TOKEN'];
  return t && t.length > 0 ? Buffer.from(t, 'utf8') : null;
}

function extractBearer(req: IncomingMessage): string {
  const h = req.headers['authorization'] ?? '';
  if (typeof h !== 'string') return '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? (m[1] ?? '') : '';
}

function isAuthorised(req: IncomingMessage, tokenBuf: Buffer | null): boolean {
  if (tokenBuf === null) return true;
  const candidate = Buffer.from(extractBearer(req), 'utf8');
  return candidate.length === tokenBuf.length && timingSafeEqual(candidate, tokenBuf);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message, type: 'error', code: status } });
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

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** POST /v1/sessions — create a new session */
async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SessionRouteDeps,
): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    const raw = await readBody(req);
    body = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    sendError(res, 400, 'Invalid or oversized request body');
    return;
  }

  const model = typeof body['model'] === 'string' ? body['model'].trim() : '';
  if (!model) {
    sendError(res, 400, 'model is required');
    return;
  }

  const sessionId = genId();
  const userId = typeof body['user_id'] === 'string' ? body['user_id'] : '';
  const platform = typeof body['source_platform'] === 'string' ? body['source_platform'] : '';
  const title = typeof body['title'] === 'string' ? body['title'] : null;
  const systemPrompt = typeof body['system_prompt'] === 'string' ? body['system_prompt'] : null;

  try {
    deps.store.createSession({
      session_id: sessionId,
      model,
      user_id: userId,
      source_platform: platform,
      title,
      system_prompt: systemPrompt,
      parent_session_id: null,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      status: 'idle',
    });

    const session = deps.store.getSession(sessionId);
    const msgCount = deps.store.getMessageCount(sessionId);
    log.info({ sessionId }, 'session created');
    sendJson(res, 201, { ...session, message_count: msgCount });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'handleCreate failed');
    sendError(res, 500, 'Internal server error');
  }
}

/** GET /v1/sessions — list sessions with optional filters */
function handleList(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SessionRouteDeps,
): void {
  const url = new URL(req.url ?? '/', `http://localhost`);
  const userId = url.searchParams.get('user_id') ?? undefined;
  const platform = url.searchParams.get('platform') ?? undefined;
  const status = url.searchParams.get('status') ?? undefined;
  const afterId = url.searchParams.get('after') ?? undefined;
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Math.max(1, Math.min(500, parseInt(limitRaw, 10))) : 50;

  try {
    // Use status as a filter if provided (post-filter since listSessions doesn't support it natively)
    const rows = deps.store.listSessions({ limit: status ? 500 : limit, userId, platform, afterId });
    const filtered = status ? rows.filter((r) => r.status === status).slice(0, limit) : rows;
    sendJson(res, 200, { object: 'list', data: filtered, count: filtered.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'handleList failed');
    sendError(res, 500, 'Internal server error');
  }
}

/** GET /v1/sessions/:id — retrieve a single session */
function handleGet(
  res: ServerResponse,
  sessionId: string,
  deps: SessionRouteDeps,
): void {
  try {
    const session = deps.store.getSession(sessionId);
    if (!session) {
      sendError(res, 404, `Session not found: ${sessionId}`);
      return;
    }
    const msgCount = deps.store.getMessageCount(sessionId);
    sendJson(res, 200, { ...session, message_count: msgCount });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, sessionId }, 'handleGet failed');
    sendError(res, 500, 'Internal server error');
  }
}

/** POST /v1/sessions/:id — update title and/or status */
async function handleUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  deps: SessionRouteDeps,
): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    const raw = await readBody(req);
    body = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    sendError(res, 400, 'Invalid or oversized request body');
    return;
  }

  const session = deps.store.getSession(sessionId);
  if (!session) {
    sendError(res, 404, `Session not found: ${sessionId}`);
    return;
  }

  // Apply title update
  if (typeof body['title'] === 'string') {
    try {
      deps.store.updateTitle(sessionId, body['title']);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, sessionId }, 'handleUpdate title failed');
      sendError(res, 500, 'Internal server error');
      return;
    }
  }

  // Apply status transition if provided
  if (typeof body['status'] === 'string') {
    try {
      deps.stateMachine.transition(sessionId, body['status'] as SessionStatus);
    } catch (err: unknown) {
      if (err instanceof SessionStateError) {
        sendError(res, err.httpStatus, err.message);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, sessionId }, 'handleUpdate status transition failed');
      sendError(res, 500, 'Internal server error');
      return;
    }
  }

  const updated = deps.store.getSession(sessionId);
  const msgCount = deps.store.getMessageCount(sessionId);
  sendJson(res, 200, { ...updated, message_count: msgCount });
}

/** POST /v1/sessions/:id/archive — archive a session (preserves history) */
function handleArchive(
  res: ServerResponse,
  sessionId: string,
  deps: SessionRouteDeps,
): void {
  const session = deps.store.getSession(sessionId);
  if (!session) {
    sendError(res, 404, `Session not found: ${sessionId}`);
    return;
  }

  // Already archived — idempotency returns 409 to indicate no transition occurred
  if (session.status === 'archived') {
    sendError(res, 409, `Session is already archived: ${sessionId}`);
    return;
  }

  try {
    deps.stateMachine.transition(sessionId, 'archived');
    const updated = deps.store.getSession(sessionId);
    const msgCount = deps.store.getMessageCount(sessionId);
    sendJson(res, 200, { ...updated, message_count: msgCount });
  } catch (err: unknown) {
    if (err instanceof SessionStateError) {
      sendError(res, err.httpStatus, err.message);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, sessionId }, 'handleArchive failed');
    sendError(res, 500, 'Internal server error');
  }
}

/** DELETE /v1/sessions/:id — hard delete (only if not running) */
function handleDelete(
  res: ServerResponse,
  sessionId: string,
  deps: SessionRouteDeps,
): void {
  const session = deps.store.getSession(sessionId);
  if (!session) {
    sendError(res, 404, `Session not found: ${sessionId}`);
    return;
  }

  if (session.status === 'running') {
    sendError(res, 409, `Cannot delete session in running state. Interrupt first.`);
    return;
  }

  try {
    const deleted = deps.store.deleteSession(sessionId);
    if (!deleted) {
      sendError(res, 404, `Session not found: ${sessionId}`);
      return;
    }
    log.info({ sessionId }, 'session deleted');
    sendJson(res, 200, { deleted: true, id: sessionId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, sessionId }, 'handleDelete failed');
    sendError(res, 500, 'Internal server error');
  }
}

/** POST /v1/sessions/:id/interrupt — force state to idle + emit user interrupt */
function handleInterrupt(
  res: ServerResponse,
  sessionId: string,
  deps: SessionRouteDeps,
): void {
  const session = deps.store.getSession(sessionId);
  if (!session) {
    sendError(res, 404, `Session not found: ${sessionId}`);
    return;
  }

  try {
    // Transition to idle regardless of current state (skip if already idle)
    const currentState = deps.stateMachine.getState(sessionId);
    if (currentState !== 'idle') {
      deps.stateMachine.transition(sessionId, 'idle');
    }
    // Emit user interrupt event (callers can listen on the state machine)
    deps.stateMachine.emit('session:user:interrupt', { sessionId });

    const updated = deps.store.getSession(sessionId);
    const msgCount = deps.store.getMessageCount(sessionId);
    sendJson(res, 200, { ...updated, message_count: msgCount, interrupted: true });
  } catch (err: unknown) {
    if (err instanceof SessionStateError) {
      sendError(res, err.httpStatus, err.message);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, sessionId }, 'handleInterrupt failed');
    sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

const SESSION_BASE = '/v1/sessions';

/**
 * Attach session REST routes to an existing http.Server.
 * Follows the same listener pattern as attachHttpApi — non-matching
 * routes fall through to other listeners.
 *
 * @param app  - Existing http.Server (shared with other route registrations).
 * @param deps - SqliteSessionStore + SessionStateMachine instances.
 */
export function registerSessionRoutes(app: HttpServer, deps: SessionRouteDeps): void {
  const tokenBuf = getTokenBuf();

  app.on('request', (req: IncomingMessage, res: ServerResponse): void => {
    const method = req.method ?? '';
    const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
    const pathname = rawPath.replace(/\/$/, '') || '/'; // normalise trailing slash

    // Only handle /v1/sessions* paths
    if (!pathname.startsWith(SESSION_BASE)) return;

    // Auth gate
    if (!isAuthorised(req, tokenBuf)) {
      sendError(res, 401, 'Unauthorized: invalid or missing bearer token');
      return;
    }

    // POST /v1/sessions — create
    if (method === 'POST' && pathname === SESSION_BASE) {
      handleCreate(req, res, deps).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg }, 'Unhandled error in handleCreate');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // GET /v1/sessions — list
    if (method === 'GET' && pathname === SESSION_BASE) {
      handleList(req, res, deps);
      return;
    }

    // Routes with /:id
    if (pathname.startsWith(`${SESSION_BASE}/`)) {
      const rest = pathname.slice(SESSION_BASE.length + 1); // strip '/v1/sessions/'
      const [sessionId, action] = rest.split('/') as [string, string | undefined];

      if (!sessionId) {
        sendError(res, 400, 'Session ID is required');
        return;
      }

      // POST /v1/sessions/:id/archive
      if (method === 'POST' && action === 'archive') {
        handleArchive(res, sessionId, deps);
        return;
      }

      // POST /v1/sessions/:id/interrupt
      if (method === 'POST' && action === 'interrupt') {
        handleInterrupt(res, sessionId, deps);
        return;
      }

      // No sub-action: id-only routes
      if (!action) {
        if (method === 'GET') {
          handleGet(res, sessionId, deps);
          return;
        }

        if (method === 'POST') {
          handleUpdate(req, res, sessionId, deps).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ err: msg, sessionId }, 'Unhandled error in handleUpdate');
            if (!res.headersSent) sendError(res, 500, 'Internal server error');
          });
          return;
        }

        if (method === 'DELETE') {
          handleDelete(res, sessionId, deps);
          return;
        }
      }
    }

    // Unrecognised sub-path within /v1/sessions/*
    sendError(res, 404, 'Not found');
  });

  log.info(
    'Session routes registered: POST/GET /v1/sessions, GET/POST/DELETE /v1/sessions/:id, ' +
    'POST /v1/sessions/:id/archive, POST /v1/sessions/:id/interrupt',
  );
}

// ---------------------------------------------------------------------------
// Factory helper — create deps from a raw Database instance
// ---------------------------------------------------------------------------

/**
 * Convenience factory: build SessionRouteDeps from a raw better-sqlite3 Database.
 * Use this in cli.ts or integration tests to avoid constructing Store + SM separately.
 */
export function buildSessionRouteDeps(db: Database): SessionRouteDeps {
  const store = new SqliteSessionStore(db);
  const stateMachine = new SessionStateMachine(db);
  return { store, stateMachine };
}
