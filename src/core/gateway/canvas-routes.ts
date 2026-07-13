/**
 * @file canvas-routes.ts
 * @description POST /v1/canvas/event — client click/submit from a rendered A2UI
 * component (Spec 2). Resolves the web peer → session and injects a TYPED
 * [CANVAS EVENT] into the agent session via the canvas bridge. Follows the
 * bench-routes.ts pattern (path-prefix guard + timing-safe bearer auth).
 *
 * NOTE: `/v1/canvas` must be in the server.ts handleRequest allowlist, or the
 * gateway 404s the request before this listener runs.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { deliverCanvasEvent, type CanvasEvent } from '../canvas/canvas-bridge.js';

const log = createLogger('gateway:canvas-routes');
const MAX_BODY = 64 * 1024;

// This endpoint is called by the WEB CHAT client, so it uses WEB_CHAT_TOKEN
// (bearer OR ?token= query — the same credential the SPA already holds), NOT the
// server-only GATEWAY_TOKEN. Unset → permissive (dev), matching the web chat.
function getTokenBuf(): Buffer | null {
  const t = process.env['WEB_CHAT_TOKEN'];
  return t && t.length > 0 ? Buffer.from(t, 'utf8') : null;
}
function extractToken(req: IncomingMessage): string {
  const h = req.headers['authorization'] ?? '';
  if (typeof h === 'string') { const m = /^Bearer\s+(.+)$/i.exec(h.trim()); if (m) return m[1] ?? ''; }
  try { return new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? ''; } catch { return ''; }
}
function isAuthorised(req: IncomingMessage, tokenBuf: Buffer | null): boolean {
  if (tokenBuf === null) return true;
  const candidate = Buffer.from(extractToken(req), 'utf8');
  return candidate.length === tokenBuf.length && timingSafeEqual(candidate, tokenBuf);
}
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []; let total = 0;
    req.on('data', (c: Buffer) => { total += c.length; if (total > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Parse + validate the inbound event body. Returns null on any malformed input. */
function parseEvent(raw: string): { peerId: string; event: CanvasEvent } | null {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  const peerId = typeof o['peerId'] === 'string' ? o['peerId'] : '';
  const actionId = typeof o['actionId'] === 'string' ? o['actionId'] : '';
  const kind = o['kind'] === 'form' ? 'form' : 'button';
  if (!peerId || !actionId) return null;
  let values: Record<string, string | number | boolean> | undefined;
  if (o['values'] && typeof o['values'] === 'object' && !Array.isArray(o['values'])) {
    values = {};
    for (const [k, v] of Object.entries(o['values'] as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') values[k] = v;
    }
  }
  return { peerId, event: { kind, actionId, ...(values ? { values } : {}) } };
}

export function registerCanvasRoutes(server: HttpServer): void {
  const tb = getTokenBuf(); // WEB_CHAT_TOKEN — the credential the web SPA holds

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? '';
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    if (!pathname.startsWith('/v1/canvas')) return;
    if (!isAuthorised(req, tb)) { sendJson(res, 401, { error: { message: 'Unauthorized', code: 401 } }); return; }

    if (method === 'POST' && pathname === '/v1/canvas/event') {
      readBody(req).then(async (raw) => {
        const parsed = parseEvent(raw);
        if (!parsed) { sendJson(res, 400, { error: { message: 'Invalid canvas event (need peerId + actionId)', code: 400 } }); return; }
        const r = await deliverCanvasEvent(parsed.peerId, parsed.event);
        sendJson(res, r.ok ? 200 : 502, r.ok ? { ok: true, sessionId: r.sessionId } : { ok: false, error: r.reason });
      }).catch((err: unknown) => {
        log.error({ err: String(err) }, 'canvas-routes: unhandled error');
        if (!res.headersSent) sendJson(res, 500, { error: { message: 'Internal server error', code: 500 } });
      });
      return;
    }

    sendJson(res, 404, { error: { message: 'Not found', code: 404 } });
  });

  log.info('Canvas routes registered (POST /v1/canvas/event)');
}
