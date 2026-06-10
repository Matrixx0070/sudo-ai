/**
 * @file routes.ts
 * @description HTTP request listener for /v1/skills REST endpoints.
 *
 * Registers on a raw node:http Server via server.on('request', ...).
 * Non-matching paths fall through silently to other listeners.
 *
 * Endpoints (6 total):
 *   GET    /v1/skills                  — list (meta only, paginated)
 *   GET    /v1/skills/:id              — retrieve (full, with body_md)
 *   GET    /v1/skills/:id/versions     — version history
 *   POST   /v1/skills/:id/attach       — attach to session (body: {sessionId, version?})
 *   POST   /v1/skills/:id/detach       — detach from session (body: {sessionId})
 *   DELETE /v1/skills/:id              — soft delete (archive, retain history)
 *
 * Auth: GATEWAY_TOKEN bearer token (timing-safe). Same pattern as agents/routes.ts.
 * Body: capped at 64 KB.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { SkillRegistry, SkillRegistryError } from './registry.js';
import { SkillImporter } from './importer.js';
import type { SkillTrustTier } from '../shared/wave10-types.js';

// ---------------------------------------------------------------------------
// SessionStore duck type — avoids importing the concrete SqliteSessionStore
// class which would create a circular-ish dependency chain. Any object with
// a getSession(id) method satisfies this interface.
// ---------------------------------------------------------------------------
export interface SessionStoreLike {
  getSession(sessionId: string): unknown;
}

const log = createLogger('skills:routes');
const MAX_BODY = 64 * 1024;
const MAX_IMPORT_BODY = 256 * 1024; // 256 KB for import endpoint

// ---------------------------------------------------------------------------
// Sliding-window rate limiter for POST /v1/skills/import (FIX 4)
// 10 requests per 60-second window per token (or per-IP if no token).
// ---------------------------------------------------------------------------

const IMPORT_RL_WINDOW_MS = 60_000;
const IMPORT_RL_MAX = 10;
const _importRlWindows = new Map<string, number[]>();

function checkImportRateLimit(req: IncomingMessage): { allowed: boolean; retryAfterSec: number } {
  const bearer = (() => {
    const h = req.headers['authorization'] ?? '';
    if (typeof h !== 'string') return '';
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    return m ? (m[1] ?? '') : '';
  })();
  const key = bearer.length > 0
    ? `token:${bearer}`
    : `ip:${(req.socket.remoteAddress ?? 'unknown')}`;

  const now = Date.now();
  const timestamps = (_importRlWindows.get(key) ?? []).filter((t) => now - t < IMPORT_RL_WINDOW_MS);

  if (timestamps.length >= IMPORT_RL_MAX) {
    const oldest = timestamps[0]!;
    const retryAfterSec = Math.ceil((IMPORT_RL_WINDOW_MS - (now - oldest)) / 1000);
    log.warn({ key, count: timestamps.length }, 'skills import rate limit exceeded');
    return { allowed: false, retryAfterSec };
  }

  timestamps.push(now);
  _importRlWindows.set(key, timestamps);
  return { allowed: true, retryAfterSec: 0 };
}

// ---------------------------------------------------------------------------
// Auth helpers (self-contained — do not import from gateway/http-api.ts)
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

function isAuthorised(req: IncomingMessage): boolean {
  const tokenBuf = getTokenBuf();
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

function sendError(res: ServerResponse, status: number, msg: string): void {
  sendJson(res, status, { error: { message: msg, code: status } });
}

async function readBody(req: IncomingMessage, maxBytes = MAX_BODY): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Session validation helper (Fix 5 — IDOR mitigation)
// Returns validated sessionId or sends an error response and returns null.
// ---------------------------------------------------------------------------

function validateSessionHeader(
  req: IncomingMessage,
  res: ServerResponse,
  bodySessionId: string,
  sessionStore: SessionStoreLike | null,
): string | null {
  const headerSessionId = req.headers['x-session-id'];
  if (typeof headerSessionId !== 'string' || !headerSessionId.trim()) {
    sendError(res, 400, 'X-Session-Id header is required');
    return null;
  }
  const headerBuf = Buffer.from(headerSessionId.trim(), 'utf8');
  const bodyBuf = Buffer.from(bodySessionId, 'utf8');
  if (headerBuf.length !== bodyBuf.length || !timingSafeEqual(headerBuf, bodyBuf)) {
    sendError(res, 422, 'X-Session-Id header and body sessionId do not match');
    return null;
  }
  if (sessionStore !== null && !sessionStore.getSession(bodySessionId)) {
    sendError(res, 404, `Session not found: ${bodySessionId}`);
    return null;
  }
  return bodySessionId;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSkillRoutes(
  server: HttpServer,
  registry: SkillRegistry,
  sessionStore: SessionStoreLike | null = null,
  importer: SkillImporter | null = null,
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    // Only handle /v1/skills paths
    if (!url.startsWith('/v1/skills')) return;

    // Auth check on all routes
    if (!isAuthorised(req)) {
      sendError(res, 401, 'Unauthorized');
      return;
    }

    void handleRequest(req, res, method, url, registry, sessionStore, importer).catch((err: unknown) => {
      log.error({ err }, 'unhandled error in skills route');
      if (!res.headersSent) sendError(res, 500, 'Internal server error');
    });
  });

  log.info('skills routes registered');
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: string,
  registry: SkillRegistry,
  sessionStore: SessionStoreLike | null,
  importer: SkillImporter | null = null,
): Promise<void> {
  // Strip query string for routing
  const [pathname] = url.split('?');
  const searchParams = new URLSearchParams(url.includes('?') ? url.split('?')[1] : '');

  // POST /v1/skills/import
  if (method === 'POST' && pathname === '/v1/skills/import') {
    // FIX 4: rate limit — 10 req/min per token (or per-IP)
    const rl = checkImportRateLimit(req);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      sendError(res, 429, 'Too many import requests — please retry later');
      return;
    }

    // C5: accept both `source` (canonical) and `uri` (legacy alias)
    let body: { uri?: unknown; source?: unknown; trustOverride?: unknown };
    try {
      body = JSON.parse(await readBody(req, MAX_IMPORT_BODY)) as {
        uri?: unknown;
        source?: unknown;
        trustOverride?: unknown;
      };
    } catch {
      sendError(res, 400, 'Invalid JSON body or body too large');
      return;
    }

    // Prefer `source` if both present; fall back to `uri` for legacy callers.
    const rawSource = typeof body.source === 'string' ? body.source.trim()
      : typeof body.uri === 'string' ? body.uri.trim() : '';
    const uri = rawSource;
    if (!uri) {
      sendError(res, 400, 'source (or uri) is required');
      return;
    }

    const validTiers = new Set(['bundled', 'indexed', 'unreviewed', 'workspace']);
    const trustOverride =
      typeof body.trustOverride === 'string' && validTiers.has(body.trustOverride)
        ? (body.trustOverride as SkillTrustTier)
        : undefined;

    const activeImporter = importer ?? new SkillImporter();

    try {
      const result = await activeImporter.import(uri, trustOverride);
      const manifest = result.manifest;

      // Check for duplicate (same name + contentHash already in registry)
      const existing = registry.getSkillMeta(manifest.name);
      if (existing && existing.sha256 === manifest.contentHash) {
        sendError(res, 409, `Skill already imported: ${manifest.name} v${manifest.version}`);
        return;
      }

      // Persist to registry — wrap in inner try/catch for precise operator error signal
      try {
        registry.registerFromImport(manifest, result.raw);
      } catch (persistErr: unknown) {
        log.error({ err: persistErr, name: manifest.name }, 'registerFromImport failed — import not persisted');
        sendError(res, 500, 'Skill import failed — contact your administrator if this persists.');
        return;
      }

      sendJson(res, 200, { skill: manifest, imported: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (msg.includes('Capability check failed') || msg.includes('CAP_VIOLATION')) {
        sendJson(res, 422, { error: { message: msg, code: 422 }, missing: [] });
        return;
      }
      if (msg.includes('Unsupported skill URI scheme') || msg.includes('Raw HTTP') || msg.includes('Invalid skill URI')) {
        sendError(res, 400, msg);
        return;
      }

      // C4: map upstream/network error types to appropriate HTTP status codes.
      // Full error (including internal URL) is logged at warn level for operator debugging.
      log.warn({ err }, 'skill import failed');

      if (msg.includes('HTTP 404') || msg.includes('HTTP 400')) {
        sendError(res, 404, 'Skill not found at requested source');
        return;
      }
      if (/HTTP 5\d\d/.test(msg)) {
        sendError(res, 502, 'Upstream source unavailable, try again later');
        return;
      }
      if (msg.toLowerCase().includes('timeout') || msg.includes('abort') || msg.includes('AbortError')) {
        sendError(res, 504, 'Import timed out');
        return;
      }
      if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('getaddrinfo')) {
        sendError(res, 502, 'Could not reach source host');
        return;
      }
      // Default catch-all: no internal details exposed
      sendError(res, 500, 'Import failed');
    }
    return;
  }

  // GET /v1/skills
  if (method === 'GET' && pathname === '/v1/skills') {
    // Fix 2: clamp limit (1–200) and floor offset at 0 to prevent DoS via negative values.
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10) || 50));
    const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10) || 0);
    const skills = registry.list(limit, offset);
    sendJson(res, 200, { data: skills, limit, offset });
    return;
  }

  // Routes with :id
  const idMatch = /^\/v1\/skills\/([^/]+)(\/.*)?$/.exec(pathname ?? '');
  if (!idMatch) {
    sendError(res, 404, 'Not found');
    return;
  }
  const id = idMatch[1] ?? '';
  const suffix = idMatch[2] ?? '';

  // GET /v1/skills/:id  or  GET /v1/skills/:id/versions
  if (method === 'GET' && (suffix === '' || suffix === '/versions')) {
    let skill;
    try {
      skill = registry.getSkillById(id);
    } catch (err) {
      if (err instanceof SkillRegistryError && err.code === 'SKILL_INJECTION_BLOCKED') {
        sendError(res, 422, err.message);
        return;
      }
      throw err;
    }
    if (!skill) { sendError(res, 404, `Skill not found: ${id}`); return; }
    if (suffix === '/versions') {
      sendJson(res, 200, { data: registry.getVersions(skill.name) });
    } else {
      sendJson(res, 200, skill);
    }
    return;
  }

  // POST /v1/skills/:id/attach
  if (method === 'POST' && suffix === '/attach') {
    let body: { sessionId?: unknown; version?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as { sessionId?: unknown; version?: unknown };
    } catch {
      sendError(res, 400, 'Invalid JSON body');
      return;
    }
    const rawSid = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!rawSid) { sendError(res, 400, 'sessionId is required'); return; }
    // Fix 5a/b/c: header required, must match body, session must exist.
    const sessionId = validateSessionHeader(req, res, rawSid, sessionStore);
    if (sessionId === null) return;

    const version = typeof body.version === 'number' ? body.version : undefined;
    try {
      const attached = registry.attachToSession(sessionId, id, version);
      sendJson(res, 200, attached);
    } catch (err) {
      if (err instanceof SkillRegistryError) {
        const status = err.code === 'NOT_FOUND' ? 404
          : err.code === 'CAP_EXCEEDED' ? 422
          : err.code === 'ARCHIVED' ? 410
          : 400;
        sendError(res, status, err.message);
      } else { throw err; }
    }
    return;
  }

  // POST /v1/skills/:id/detach
  if (method === 'POST' && suffix === '/detach') {
    let body: { sessionId?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as { sessionId?: unknown };
    } catch {
      sendError(res, 400, 'Invalid JSON body');
      return;
    }
    const rawSid = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!rawSid) { sendError(res, 400, 'sessionId is required'); return; }
    // Fix 5a/b/c: header required, must match body, session must exist.
    const sessionId = validateSessionHeader(req, res, rawSid, sessionStore);
    if (sessionId === null) return;

    try {
      registry.detachFromSession(sessionId, id);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      if (err instanceof SkillRegistryError) {
        sendError(res, 400, err.message);
      } else { throw err; }
    }
    return;
  }

  // DELETE /v1/skills/:id
  if (method === 'DELETE' && suffix === '') {
    try {
      registry.archive(id);
      sendJson(res, 200, { ok: true, archived: true });
    } catch (err) {
      if (err instanceof SkillRegistryError) {
        const status = err.code === 'NOT_FOUND' ? 404 : 400;
        sendError(res, status, err.message);
      } else {
        throw err;
      }
    }
    return;
  }

  sendError(res, 404, 'Not found');
}
