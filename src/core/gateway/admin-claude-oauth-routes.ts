/**
 * @file admin-claude-oauth-routes.ts
 * @description Admin REST routes for the Claude OAuth (PKCE) connector.
 *
 * Routes:
 *   GET  /v1/admin/claude-oauth/status     — current connection state
 *   POST /v1/admin/claude-oauth/login/start    — begin PKCE handshake, returns authorize URL
 *   POST /v1/admin/claude-oauth/login/complete — exchange pasted code for tokens
 *   POST /v1/admin/claude-oauth/refresh    — force a token refresh
 *   POST /v1/admin/claude-oauth/disconnect — wipe stored credentials
 *
 * Auth: timing-safe Bearer token (helpers copied inline — mirrors admin-sleep-routes.ts).
 */

import { timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { getClaudeOAuthManager } from '../brain/claude-oauth-manager.js';
import { reinitProvider } from '../brain/providers.js';

const log = createLogger('gateway:admin-claude-oauth');

const MAX_BODY = 64 * 1024;

// ---------------------------------------------------------------------------
// Auth + HTTP helpers (inline — same pattern as admin-sleep-routes.ts)
// ---------------------------------------------------------------------------

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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // This router is one of several 'request' listeners on the shared gateway
  // server. If another listener already wrote a response, a second writeHead
  // throws ERR_HTTP_HEADERS_SENT, which escalates to uncaughtException and
  // takes the whole daemon down (observed live 2026-07-04 on a
  // /v1/admin/claude-oauth/status dashboard poll).
  if (res.headersSent || res.writableEnded) {
    log.warn({ status }, 'sendJson skipped — response already written by another listener');
    return;
  }
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

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleStatus(res: ServerResponse): void {
  const mgr = getClaudeOAuthManager();
  sendJson(res, 200, { ok: true, data: mgr.getStatus() });
}

function handleLoginStart(res: ServerResponse): void {
  const mgr = getClaudeOAuthManager();
  const pending = mgr.startLogin();
  // The verifier MUST stay server-side; only return the URL (and a state token
  // the UI shows for sanity checking — not needed for completion).
  sendJson(res, 200, {
    ok: true,
    data: {
      authorizeUrl: pending.authorizeUrl,
      state: pending.state,
    },
  });
}

async function handleLoginComplete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    const raw = await readBody(req);
    body = raw.length > 0 ? (JSON.parse(raw) as unknown) : {};
  } catch {
    sendError(res, 400, 'Invalid or oversized request body');
    return;
  }

  const code = (body as Record<string, unknown>)['code'];
  if (typeof code !== 'string' || code.trim().length === 0) {
    sendError(res, 400, 'code (string) is required');
    return;
  }

  try {
    const mgr = getClaudeOAuthManager();
    await mgr.completeLogin(code);
    mgr.startAutoRefresh();
    // Rebuild the brain provider so getModel('claude-oauth/...') starts working.
    await reinitProvider('claude-oauth').catch((err: unknown) => {
      log.warn({ err: String(err) }, 'reinitProvider(claude-oauth) failed — provider will pick up on next boot');
    });
    sendJson(res, 200, { ok: true, data: mgr.getStatus() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'Claude OAuth login complete failed');
    sendError(res, 400, msg);
  }
}

async function handleRefresh(res: ServerResponse): Promise<void> {
  const mgr = getClaudeOAuthManager();
  if (!mgr.isAvailable()) {
    sendError(res, 400, 'Not connected — run login first');
    return;
  }
  const ok = await mgr.refreshToken();
  if (!ok) {
    sendError(res, 502, 'Refresh failed — see server logs');
    return;
  }
  sendJson(res, 200, { ok: true, data: mgr.getStatus() });
}

function handleDisconnect(res: ServerResponse): void {
  const mgr = getClaudeOAuthManager();
  mgr.disconnect();
  sendJson(res, 200, { ok: true, data: { connected: false } });
}

async function handleModelsGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const mgr = getClaudeOAuthManager();
  if (!mgr.isAvailable()) {
    sendError(res, 400, 'Not connected — run login first');
    return;
  }
  // `?refresh=1` forces a live fetch; otherwise return the cached list when fresh.
  const url = new URL(req.url ?? '/', 'http://localhost');
  const wantRefresh = url.searchParams.get('refresh') === '1';
  try {
    const models = wantRefresh ? await mgr.refreshModels() : await mgr.getModelsLazy();
    sendJson(res, 200, { ok: true, data: { models, defaultModel: mgr.getDefaultModel() } });
  } catch (err) {
    sendError(res, 502, err instanceof Error ? err.message : String(err));
  }
}

async function handleDefaultModelPut(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    const raw = await readBody(req);
    body = raw.length > 0 ? (JSON.parse(raw) as unknown) : {};
  } catch {
    sendError(res, 400, 'Invalid or oversized request body');
    return;
  }
  const id = (body as Record<string, unknown>)['modelId'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    sendError(res, 400, 'modelId (string) is required');
    return;
  }
  const mgr = getClaudeOAuthManager();
  if (!mgr.isAvailable()) {
    sendError(res, 400, 'Not connected — run login first');
    return;
  }
  const ok = mgr.setDefaultModel(id.trim());
  if (!ok) {
    sendError(res, 400, `Model id "${id.trim()}" is not in the cached list — refresh models and retry`);
    return;
  }
  sendJson(res, 200, { ok: true, data: { defaultModel: mgr.getDefaultModel() } });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAdminClaudeOAuthRoutes(server: HttpServer, tokenBuf: Buffer | null): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? '';
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';

    if (!pathname.startsWith('/v1/admin/claude-oauth')) return;

    if (!isAuthorised(req, tokenBuf)) {
      sendError(res, 401, 'Unauthorized: invalid or missing bearer token');
      return;
    }

    if (method === 'GET' && pathname === '/v1/admin/claude-oauth/status') {
      handleStatus(res);
      return;
    }
    if (method === 'POST' && pathname === '/v1/admin/claude-oauth/login/start') {
      handleLoginStart(res);
      return;
    }
    if (method === 'POST' && pathname === '/v1/admin/claude-oauth/login/complete') {
      handleLoginComplete(req, res).catch((err: unknown) => {
        log.error({ err: String(err) }, 'Unhandled error in login/complete');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }
    if (method === 'POST' && pathname === '/v1/admin/claude-oauth/refresh') {
      handleRefresh(res).catch((err: unknown) => {
        log.error({ err: String(err) }, 'Unhandled error in refresh');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }
    if (method === 'POST' && pathname === '/v1/admin/claude-oauth/disconnect') {
      handleDisconnect(res);
      return;
    }
    if (method === 'GET' && pathname === '/v1/admin/claude-oauth/models') {
      handleModelsGet(req, res).catch((err: unknown) => {
        log.error({ err: String(err) }, 'Unhandled error in models');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }
    if (method === 'PUT' && pathname === '/v1/admin/claude-oauth/default-model') {
      handleDefaultModelPut(req, res).catch((err: unknown) => {
        log.error({ err: String(err) }, 'Unhandled error in default-model');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    sendError(res, 404, 'Unknown claude-oauth admin route');
  });

  log.info(
    'Admin Claude OAuth routes registered: status, login/start, login/complete, refresh, disconnect, models, default-model',
  );
}
