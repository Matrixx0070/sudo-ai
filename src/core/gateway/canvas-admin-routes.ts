/**
 * @file canvas-admin-routes.ts
 * @description GET /v1/admin/canvas — read-only monitoring of the interactive
 * UI the agent is currently rendering to sessions (Spec 2 / A2UI). Returns the
 * most-recently-updated canvases from the per-session store so the operator
 * dashboard can display them. GATEWAY_TOKEN auth (the admin credential), unlike
 * the WEB_CHAT_TOKEN used by /v1/canvas/event (the end-user's credential).
 *
 * NOTE: registered as its OWN listener AFTER admin-routes, which defers
 * `/v1/admin/canvas` (see admin-routes.ts fall-through list) — mirroring how
 * bench/learning routes attach. Avoids a two-responder race on one request.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { listCanvasStates } from '../canvas/canvas-bridge.js';

const log = createLogger('gateway:canvas-admin-routes');

function extractToken(req: IncomingMessage): string {
  const h = req.headers['authorization'] ?? '';
  if (typeof h === 'string') { const m = /^Bearer\s+(.+)$/i.exec(h.trim()); if (m) return m[1] ?? ''; }
  try { return new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? ''; } catch { return ''; }
}
function isAuthorised(req: IncomingMessage, tokenBuf: Buffer | null): boolean {
  if (tokenBuf === null) return true; // unset → permissive (dev), matching other admin routes
  const candidate = Buffer.from(extractToken(req), 'utf8');
  return candidate.length === tokenBuf.length && timingSafeEqual(candidate, tokenBuf);
}
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // Defensive: never write headers twice if another listener already answered
  // this request (see admin-routes defer). Prevents an ERR_HTTP_HEADERS_SENT
  // crash from taking down the daemon.
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** @param tokenBuf GATEWAY_TOKEN buffer (admin credential), or null when unset. */
export function registerCanvasAdminRoutes(server: HttpServer, tokenBuf: Buffer | null): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? '';
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    if (pathname !== '/v1/admin/canvas') return;
    if (!isAuthorised(req, tokenBuf)) { sendJson(res, 401, { error: { message: 'Unauthorized', code: 401 } }); return; }
    if (method !== 'GET') { sendJson(res, 404, { error: { message: 'Not found', code: 404 } }); return; }

    try {
      const limitRaw = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit') ?? '20');
      const limit = Number.isFinite(limitRaw) ? limitRaw : 20;
      const states = listCanvasStates(limit).map((s) => ({
        sessionId: s.sessionId,
        updatedAt: s.updatedAt,
        title: s.payload.title,
        componentCount: s.payload.components.length,
        components: s.payload.components,
      }));
      sendJson(res, 200, { ok: true, data: states });
    } catch (err) {
      log.error({ err: String(err) }, 'canvas-admin-routes: unhandled error');
      if (!res.headersSent) sendJson(res, 500, { error: { message: 'Internal server error', code: 500 } });
    }
  });

  log.info('Canvas admin routes registered (GET /v1/admin/canvas)');
}
