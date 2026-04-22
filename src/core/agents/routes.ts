/**
 * @file routes.ts
 * @description HTTP request listener for /v1/agents REST endpoints.
 *
 * Registers on a raw node:http Server via server.on('request', ...).
 * Non-matching paths fall through silently to other listeners.
 *
 * Endpoints (6 total):
 *   POST   /v1/agents              — create
 *   GET    /v1/agents              — list (paginated)
 *   GET    /v1/agents/:id          — retrieve (optional ?version=N)
 *   POST   /v1/agents/:id          — update (optimistic lock)
 *   GET    /v1/agents/:id/versions — version history
 *   POST   /v1/agents/:id/archive  — archive
 *
 * Auth: GATEWAY_TOKEN env var (timing-safe). Same pattern as gateway/http-api.ts.
 * Body: capped at 256 KB.
 *
 * NOTE: Builder B will wire registerAgentRoutes() into the gateway in a
 * single commit after all Wave 5 modules are complete.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { AgentConfigStore } from './store.js';
import { AgentConfigStoreError } from './config-types.js';
import { MemoryInjectionError } from '../memory/injection-scanner.js';
import { validateCreate, validateUpdate } from './validation.js';

const log = createLogger('agents:routes');
const MAX_BODY = 256 * 1024;

// ---------------------------------------------------------------------------
// Auth (reimplemented — cannot import from gateway/http-api.ts)
// ---------------------------------------------------------------------------

function getTokenBuf(): Buffer | null {
  const t = process.env['GATEWAY_TOKEN'];
  return t && t.length > 0 ? Buffer.from(t, 'utf8') : null;
}

function isAuthorised(req: IncomingMessage): boolean {
  const tokenBuf = getTokenBuf();
  if (!tokenBuf) return true;
  const h = req.headers['authorization'] ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(typeof h === 'string' ? h.trim() : '');
  const candidate = Buffer.from(m ? (m[1] ?? '') : '', 'utf8');
  return candidate.length === tokenBuf.length && timingSafeEqual(candidate, tokenBuf);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const p = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p) });
  res.end(p);
}

function sendError(res: ServerResponse, status: number, msg: string): void {
  sendJson(res, status, { error: { message: msg, code: status } });
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

interface RouteMatch { agentId?: string; sub?: 'versions' | 'archive'; }

function matchRoute(pathname: string): RouteMatch | null {
  if (pathname === '/v1/agents') return {};
  const m = /^\/v1\/agents\/([^/]+)(?:\/(versions|archive))?$/.exec(pathname);
  if (!m) return null;
  return { agentId: m[1], sub: m[2] as 'versions' | 'archive' | undefined };
}

// ---------------------------------------------------------------------------
// Error handling for store exceptions
// ---------------------------------------------------------------------------

function handleStoreError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof MemoryInjectionError) {
    log.warn({ reasons: err.details?.['reasons'] }, 'injection detected in agent route');
    sendError(res, 422, 'Content rejected: injection pattern detected');
    return true;
  }
  if (err instanceof AgentConfigStoreError) {
    const c = err.code as string;
    if (c === 'agent_not_found')       { sendError(res, 404, err.message); return true; }
    if (c === 'agent_version_conflict') { sendError(res, 409, err.message); return true; }
    if (c === 'agent_archived')         { sendError(res, 409, err.message); return true; }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleCreate(req: IncomingMessage, res: ServerResponse, store: AgentConfigStore): Promise<void> {
  let body: unknown;
  try { body = JSON.parse(await readBody(req)); } catch { sendError(res, 400, 'Invalid JSON body'); return; }
  const err = validateCreate(body);
  if (err) { sendError(res, 400, err); return; }
  const config = store.create(body as Parameters<AgentConfigStore['create']>[0]);
  sendJson(res, 201, config);
}

function handleList(parsed: URL, res: ServerResponse, store: AgentConfigStore): void {
  const raw = parseInt(parsed.searchParams.get('limit') ?? '50', 10);
  const limit = isNaN(raw) || raw < 1 ? 50 : Math.min(raw, 100);
  const after_id = parsed.searchParams.get('after_id') ?? undefined;
  const include_archived = parsed.searchParams.get('include_archived') === 'true';
  const data = store.list({ limit, after_id, include_archived });
  sendJson(res, 200, { data, has_more: data.length === limit });
}

function handleGet(agentId: string, parsed: URL, res: ServerResponse, store: AgentConfigStore): void {
  const vp = parsed.searchParams.get('version');
  let version: number | undefined;
  if (vp !== null) {
    version = parseInt(vp, 10);
    if (isNaN(version) || version < 1) { sendError(res, 400, '"version" must be a positive integer'); return; }
  }
  const config = store.get(agentId, version);
  if (!config) { sendError(res, 404, `Agent not found: ${agentId}`); return; }
  sendJson(res, 200, config);
}

async function handleUpdate(agentId: string, req: IncomingMessage, res: ServerResponse, store: AgentConfigStore): Promise<void> {
  let body: unknown;
  try { body = JSON.parse(await readBody(req)); } catch { sendError(res, 400, 'Invalid JSON body'); return; }
  const err = validateUpdate(body);
  if (err) { sendError(res, 400, err); return; }
  const config = store.update(agentId, body as Parameters<AgentConfigStore['update']>[1]);
  sendJson(res, 200, config);
}

function handleVersions(agentId: string, res: ServerResponse, store: AgentConfigStore): void {
  const versions = store.versions(agentId);
  if (versions.length === 0) { sendError(res, 404, `Agent not found: ${agentId}`); return; }
  sendJson(res, 200, { data: versions });
}

function handleArchive(agentId: string, res: ServerResponse, store: AgentConfigStore): void {
  const config = store.archive(agentId);
  sendJson(res, 200, config);
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

async function dispatch(
  method: string, parsed: URL, match: RouteMatch,
  req: IncomingMessage, res: ServerResponse, store: AgentConfigStore,
): Promise<void> {
  const { agentId, sub } = match;

  try {
    if (!agentId && method === 'POST') { await handleCreate(req, res, store); return; }
    if (!agentId && method === 'GET')  { handleList(parsed, res, store); return; }
    if (!agentId) { sendError(res, 405, 'Method not allowed'); return; }

    if (sub === 'versions' && method === 'GET')    { handleVersions(agentId, res, store); return; }
    if (sub === 'archive'  && method === 'POST')   { handleArchive(agentId, res, store); return; }
    if (!sub && method === 'GET')  { handleGet(agentId, parsed, res, store); return; }
    if (!sub && method === 'POST') { await handleUpdate(agentId, req, res, store); return; }

    sendError(res, 405, 'Method not allowed');
  } catch (err) {
    if (!handleStoreError(res, err)) throw err;
  }
}

// ---------------------------------------------------------------------------
// Public: registerAgentRoutes
// ---------------------------------------------------------------------------

export function registerAgentRoutes(server: HttpServer, store: AgentConfigStore): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method  = (req.method ?? 'GET').toUpperCase();
    const parsed  = new URL(req.url ?? '/', 'http://localhost');
    const match   = matchRoute(parsed.pathname);
    if (!match) return; // not our path — fall through

    if (!isAuthorised(req)) { sendError(res, 401, 'Unauthorized'); return; }

    dispatch(method, parsed, match, req, res, store).catch((err: unknown) => {
      log.error({ err: String(err) }, 'agents route unhandled error');
      if (!res.headersSent) sendError(res, 500, 'Internal server error');
    });
  });
  log.info('agent config routes registered on /v1/agents');
}
