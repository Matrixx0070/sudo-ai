/**
 * @file admin-router.ts
 * @description REST route dispatcher for all /api/admin/* endpoints.
 *
 * Auth: if SUDO_AI_DASHBOARD_TOKEN env var is set, every request must carry
 *       an "Authorization: Bearer <token>" header.
 *
 * Usage:
 *   adminRouter.get('/api/admin/foo', async (req, res, params) => { ... });
 *   const handled = await adminRouter.dispatch(req, res);
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from '../shared/logger.js';

const log = createLogger('api:admin-router');

// ---------------------------------------------------------------------------
// CORS — admin panel allowed origins
// Mirrors the allowlist pattern used by http-server.ts.
// Override via SUDO_AI_CORS_ORIGINS (comma-separated) if needed.
// ---------------------------------------------------------------------------

const ADMIN_DEFAULT_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:5173',
];

function buildAdminAllowedOrigins(): Set<string> {
  const raw = process.env['SUDO_AI_CORS_ORIGINS'];
  if (!raw || raw.trim().length === 0) {
    return new Set(ADMIN_DEFAULT_CORS_ORIGINS);
  }
  const parsed = raw.split(',').map((o) => o.trim()).filter(Boolean);
  log.info({ origins: parsed }, 'Admin CORS allowed origins loaded from SUDO_AI_CORS_ORIGINS');
  return new Set(parsed);
}

const ADMIN_ALLOWED_ORIGINS: Set<string> = buildAdminAllowedOrigins();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Handler function signature for admin routes. */
export type AdminHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: AdminHandler;
}

// ---------------------------------------------------------------------------
// AdminRouter
// ---------------------------------------------------------------------------

export class AdminRouter {
  private readonly _routes: Route[] = [];

  /**
   * Register a route. Path supports :param syntax.
   * e.g. register('GET', '/api/admin/models/:id', handler)
   */
  register(method: string, path: string, handler: AdminHandler): void {
    if (!method || !path || typeof handler !== 'function') {
      throw new TypeError('AdminRouter.register: method, path and handler are required');
    }
    const paramNames: string[] = [];
    const patternStr = path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    const upperMethod = method.toUpperCase();
    const pattern = new RegExp(`^${patternStr}$`);

    // Replace existing route with same method+pattern (allows real handlers to override stubs)
    const existingIdx = this._routes.findIndex(
      (r) => r.method === upperMethod && r.pattern.source === pattern.source,
    );
    const route = { method: upperMethod, pattern, paramNames, handler };
    if (existingIdx >= 0) {
      this._routes[existingIdx] = route;
      log.debug({ method, path }, 'Admin route replaced');
    } else {
      this._routes.push(route);
      log.debug({ method, path }, 'Admin route registered');
    }
  }

  get(path: string, handler: AdminHandler): void    { this.register('GET',    path, handler); }
  post(path: string, handler: AdminHandler): void   { this.register('POST',   path, handler); }
  put(path: string, handler: AdminHandler): void    { this.register('PUT',    path, handler); }
  delete(path: string, handler: AdminHandler): void { this.register('DELETE', path, handler); }

  /**
   * Dispatch an incoming request.
   * Returns true if the request was handled (regardless of status code).
   * Returns false if no route matched — caller should continue to next handler.
   */
  async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = (req.url ?? '/').split('?')[0] ?? '/';

    // --- CORS pre-flight ---------------------------------------------------
    // Only reflect the Origin header when it is on the allowlist.
    // A wildcard '*' is intentionally avoided — the admin API is privileged.
    const requestOrigin = req.headers['origin'];
    if (typeof requestOrigin === 'string' && ADMIN_ALLOWED_ORIGINS.has(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      res.setHeader('Vary', 'Origin');
    } else if (typeof requestOrigin === 'string') {
      log.warn({ origin: requestOrigin, url, method }, 'Admin CORS: rejected disallowed origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    // --- Bearer token auth ------------------------------------------------
    const requiredToken = process.env['SUDO_AI_DASHBOARD_TOKEN'];
    if (requiredToken) {
      // Constant-time compare (timingSafeEqual) so a direct caller of dispatch()
      // that bypasses the gateway registrar still gets no timing oracle.
      const authHeader = (req.headers['authorization'] ?? '') as string;
      const m = /^Bearer\s+(.+)$/i.exec(authHeader);
      const tokenBuf = Buffer.from(requiredToken, 'utf8');
      const candBuf = m ? Buffer.from(m[1]!.trim(), 'utf8') : Buffer.alloc(0);
      const ok = candBuf.length === tokenBuf.length && timingSafeEqual(candBuf, tokenBuf);
      if (!ok) {
        log.warn(
          { ip: (req.socket as { remoteAddress?: string })?.remoteAddress, url, method },
          'Admin auth failed — invalid or missing Bearer token',
        );
        sendJson(res, 401, { error: { message: 'Unauthorized', code: 401 } });
        return true;
      }
    }

    // --- Route matching ---------------------------------------------------
    for (const route of this._routes) {
      if (route.method !== method) continue;
      const match = url.match(route.pattern);
      if (!match) continue;

      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = match[i + 1] ?? '';
      });

      log.debug({ method, url, params }, 'Admin route matched');

      try {
        await route.handler(req, res, params);
      } catch (err) {
        log.error({ err, method, url }, 'Admin handler threw unhandled error');
        if (!res.headersSent) {
          sendJson(res, 500, { error: { message: 'Internal server error', code: 500 } });
        }
      }
      return true;
    }

    // No route matched — signal caller to fall through
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared response helpers (exported for use by handler modules)
// ---------------------------------------------------------------------------

/** Write a JSON response with Content-Type and Content-Length set. */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    log.warn({ status }, 'sendJson called after headers already sent — skipping');
    return;
  }
  let json: string;
  try {
    json = JSON.stringify(body);
  } catch (err) {
    log.error({ err }, 'sendJson: JSON.stringify failed');
    json = JSON.stringify({ error: { message: 'Response serialisation failed', code: 500 } });
    status = 500;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/**
 * Read and parse the request body as JSON.
 * Resolves to {} on empty body.
 * Rejects with Error('Invalid JSON') on parse failure.
 * Rejects with Error('Request body too large') if body exceeds maxBytes.
 */
export function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = 1_048_576, // 1 MiB
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        reject(new Error(`Request body too large (max ${maxBytes} bytes)`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', (err) => {
      log.error({ err }, 'readJsonBody: request stream error');
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Singleton router instance
// ---------------------------------------------------------------------------

export const adminRouter = new AdminRouter();

// ---------------------------------------------------------------------------
// Stub factory — returns a handler that answers 501 until a real handler
// (registered by admin/index.ts registerAdminHandlers) overrides the route.
// ---------------------------------------------------------------------------

function stub(section: string): AdminHandler {
  return async (_req, res) => {
    sendJson(res, 501, {
      error: { message: 'Not implemented', code: 501 },
      section,
    });
  };
}

// ---------------------------------------------------------------------------
// Route registrations — one block per admin section
// ---------------------------------------------------------------------------

// Dashboard
adminRouter.get('/api/admin/dashboard/stats',   stub('dashboard'));
adminRouter.post('/api/admin/service/restart',  stub('service'));
adminRouter.post('/api/admin/service/stop',     stub('service'));

// Models
adminRouter.get('/api/admin/models/config',                    stub('models'));
adminRouter.put('/api/admin/models/config',                    stub('models'));
adminRouter.get('/api/admin/models/providers',                 stub('models'));
adminRouter.post('/api/admin/models/providers/:id/test',       stub('models'));
adminRouter.put('/api/admin/models/providers/:id/key',         stub('models'));
adminRouter.get('/api/admin/models/cost',                      stub('models'));

// Channels
adminRouter.get('/api/admin/channels',                         stub('channels'));
adminRouter.put('/api/admin/channels/:type',                   stub('channels'));
adminRouter.post('/api/admin/channels/:type/toggle',           stub('channels'));
adminRouter.post('/api/admin/channels/:type/test',             stub('channels'));
adminRouter.get('/api/admin/channels/:type/messages',          stub('channels'));

// Tools
adminRouter.get('/api/admin/tools',                            stub('tools'));
adminRouter.post('/api/admin/tools/:name/toggle',              stub('tools'));
adminRouter.get('/api/admin/tools/stats',                      stub('tools'));
adminRouter.put('/api/admin/tools/browser-config',             stub('tools'));

// Consciousness
adminRouter.get('/api/admin/consciousness/state',              stub('consciousness'));
adminRouter.get('/api/admin/consciousness/modules',            stub('consciousness'));
adminRouter.get('/api/admin/consciousness/thoughts',           stub('consciousness'));
adminRouter.get('/api/admin/consciousness/emotions',           stub('consciousness'));
adminRouter.get('/api/admin/consciousness/body',               stub('consciousness'));
adminRouter.get('/api/admin/consciousness/episodes',           stub('consciousness'));

// Cron
adminRouter.get('/api/admin/cron/jobs',                        stub('cron'));
adminRouter.post('/api/admin/cron/jobs',                       stub('cron'));
adminRouter.put('/api/admin/cron/jobs/:id',                    stub('cron'));
adminRouter.delete('/api/admin/cron/jobs/:id',                 stub('cron'));
adminRouter.post('/api/admin/cron/jobs/:id/toggle',            stub('cron'));
adminRouter.post('/api/admin/cron/jobs/:id/run',               stub('cron'));
adminRouter.get('/api/admin/cron/history',                     stub('cron'));

// Settings
adminRouter.get('/api/admin/settings',                         stub('settings'));
adminRouter.put('/api/admin/settings/meta',                    stub('settings'));
adminRouter.put('/api/admin/settings/agents',                  stub('settings'));
adminRouter.put('/api/admin/settings/gateway',                 stub('settings'));
adminRouter.get('/api/admin/settings/personas',                stub('settings'));
adminRouter.put('/api/admin/settings/persona',                 stub('settings'));

// Security
adminRouter.get('/api/admin/security/tokens',                  stub('security'));
adminRouter.post('/api/admin/security/tokens',                 stub('security'));
adminRouter.delete('/api/admin/security/tokens/:id',           stub('security'));
adminRouter.get('/api/admin/security/cors',                    stub('security'));
adminRouter.put('/api/admin/security/cors',                    stub('security'));
adminRouter.get('/api/admin/security/credentials',             stub('security'));
adminRouter.get('/api/admin/security/access-log',              stub('security'));

// Logs
adminRouter.get('/api/admin/logs',                             stub('logs'));
adminRouter.get('/api/admin/logs/download',                    stub('logs'));

// System
adminRouter.get('/api/admin/system/info',                      stub('system'));
adminRouter.get('/api/admin/system/doctor',                    stub('system'));
adminRouter.post('/api/admin/system/backup',                   stub('system'));
adminRouter.post('/api/admin/system/restore',                  stub('system'));
adminRouter.get('/api/admin/system/databases',                 stub('system'));
adminRouter.get('/api/admin/system/env',                       stub('system'));

// Sessions
adminRouter.get('/api/admin/sessions',                         stub('sessions'));
adminRouter.get('/api/admin/sessions/:id',                     stub('sessions'));
adminRouter.delete('/api/admin/sessions/:id',                  stub('sessions'));
