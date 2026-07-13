/**
 * @file browser-admin-routes.ts
 * @description Owner-facing watch/takeover endpoints for durable browser
 * profiles (Spec 3, step 4), under /v1/admin/browser (GATEWAY_TOKEN — the admin
 * credential; `?token=` accepted so an <img> MJPEG stream can authenticate).
 *
 *   GET  /v1/admin/browser/status              → active casts + running profiles
 *   GET  /v1/admin/browser/live?profile=X      → MJPEG live screen (multipart)
 *   GET  /v1/admin/browser/frame?profile=X      → latest JPEG (single)
 *   POST /v1/admin/browser/watch    {profile, action:start|stop, fps?}
 *   POST /v1/admin/browser/takeover {profile, action:take|hand-back}
 *   POST /v1/admin/browser/input    {profile, kind, ...}   (owner drives)
 *
 * Registered as its own listener AFTER admin-routes, which DEFERS /v1/admin/browser
 * before its auth gate (else the two-responder / headers-sent race).
 */

import { timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { screencastManager } from '../tools/builtin/browser/screencast-manager.js';
import { BrowserManager } from '../tools/builtin/browser/browser-manager.js';

const log = createLogger('gateway:browser-admin-routes');
const MAX_BODY = 16 * 1024;

function extractToken(req: IncomingMessage): string {
  const h = req.headers['authorization'] ?? '';
  if (typeof h === 'string') { const m = /^Bearer\s+(.+)$/i.exec(h.trim()); if (m) return m[1] ?? ''; }
  try { return new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? ''; } catch { return ''; }
}
function isAuthorised(req: IncomingMessage, tokenBuf: Buffer | null): boolean {
  if (tokenBuf === null) return true;
  const cand = Buffer.from(extractToken(req), 'utf8');
  return cand.length === tokenBuf.length && timingSafeEqual(cand, tokenBuf);
}
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let total = 0;
    req.on('data', (c: Buffer) => { total += c.length; if (total > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function query(req: IncomingMessage, key: string): string {
  try { return new URL(req.url ?? '/', 'http://localhost').searchParams.get(key) ?? ''; } catch { return ''; }
}

/** Inject one owner input event via the Playwright page (takeover). */
async function handleInput(profile: string, body: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> {
  const page = screencastManager.getPage(profile);
  if (!page) return { ok: false, reason: 'no active screencast for profile' };
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  const kind = String(body['kind'] ?? '');
  // Coords are normalized [0,1] relative to the displayed frame → CSS pixels.
  const nx = Math.max(0, Math.min(1, Number(body['x']) || 0));
  const ny = Math.max(0, Math.min(1, Number(body['y']) || 0));
  const px = Math.round(nx * vp.width), py = Math.round(ny * vp.height);
  try {
    switch (kind) {
      case 'click': await page.mouse.click(px, py); return { ok: true };
      case 'move': await page.mouse.move(px, py); return { ok: true };
      case 'scroll': await page.mouse.wheel(0, Number(body['dy']) || 0); return { ok: true };
      case 'text': await page.keyboard.type(String(body['text'] ?? '').slice(0, 2000)); return { ok: true };
      case 'key': await page.keyboard.press(String(body['key'] ?? '').slice(0, 40)); return { ok: true };
      default: return { ok: false, reason: `unknown input kind "${kind}"` };
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function registerBrowserAdminRoutes(server: HttpServer, tokenBuf: Buffer | null): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? '';
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    if (!pathname.startsWith('/v1/admin/browser')) return;
    if (!isAuthorised(req, tokenBuf)) { sendJson(res, 401, { error: { message: 'Unauthorized', code: 401 } }); return; }

    // --- GET status ---
    if (method === 'GET' && pathname === '/v1/admin/browser/status') {
      sendJson(res, 200, { ok: true, data: { casts: screencastManager.list(), running: BrowserManager.getInstance().list() } });
      return;
    }

    // --- GET live (MJPEG) ---
    if (method === 'GET' && pathname === '/v1/admin/browser/live') {
      const profile = query(req, 'profile');
      if (!screencastManager.subscribeMJPEG(profile, res)) {
        sendJson(res, 404, { error: { message: `no active screencast for "${profile}" — start watch first`, code: 404 } });
      }
      return; // MJPEG stream stays open
    }

    // --- GET frame (single latest JPEG) ---
    if (method === 'GET' && pathname === '/v1/admin/browser/frame') {
      const buf = screencastManager.latestFrame(query(req, 'profile'));
      if (!buf) { sendJson(res, 404, { error: { message: 'no frame yet', code: 404 } }); return; }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      res.end(buf);
      return;
    }

    // --- POST watch / takeover / input ---
    if (method === 'POST') {
      readBody(req).then(async (raw) => {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(raw || '{}') as Record<string, unknown>; } catch { sendJson(res, 400, { error: { message: 'bad JSON', code: 400 } }); return; }
        const profile = typeof body['profile'] === 'string' ? body['profile'] : '';
        if (!profile) { sendJson(res, 400, { error: { message: 'profile required', code: 400 } }); return; }
        const action = String(body['action'] ?? '');

        if (pathname === '/v1/admin/browser/watch') {
          if (action === 'stop') { const ok = await screencastManager.stop(profile); sendJson(res, 200, { ok }); return; }
          try {
            await screencastManager.start(profile, { fps: Number(body['fps']) || undefined });
            sendJson(res, 200, { ok: true, profile });
          } catch (err) { sendJson(res, 409, { ok: false, error: err instanceof Error ? err.message : String(err) }); }
          return;
        }
        if (pathname === '/v1/admin/browser/takeover') {
          const on = action !== 'hand-back';
          const ok = screencastManager.setTakeover(profile, on);
          sendJson(res, ok ? 200 : 404, ok ? { ok: true, takeover: on } : { ok: false, error: 'no active screencast' });
          return;
        }
        if (pathname === '/v1/admin/browser/input') {
          if (!screencastManager.isTakenOver(profile)) { sendJson(res, 409, { ok: false, error: 'take over first (agent still owns the browser)' }); return; }
          const r = await handleInput(profile, body);
          sendJson(res, r.ok ? 200 : 400, r);
          return;
        }
        sendJson(res, 404, { error: { message: 'not found', code: 404 } });
      }).catch((err: unknown) => {
        log.error({ err: String(err) }, 'browser-admin-routes: unhandled');
        if (!res.headersSent) sendJson(res, 500, { error: { message: 'internal error', code: 500 } });
      });
      return;
    }

    sendJson(res, 404, { error: { message: 'not found', code: 404 } });
  });

  log.info('Browser admin routes registered (/v1/admin/browser/{status,live,frame,watch,takeover,input})');
}
