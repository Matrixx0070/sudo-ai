/**
 * @file admin/register.ts
 * @description Mounts the AdminRouter (api/admin-router.ts + its handlers) onto
 * the gateway HTTP server, behind a fail-closed Bearer gate.
 *
 * Opt-in: SUDO_ADMIN_API=1. When unset, no listener is attached and the gateway
 * keeps 404-ing /api/admin/* (byte-identical to before this feature).
 *
 * Auth is enforced HERE, at the gateway boundary, BEFORE adminRouter.dispatch —
 * never relying on dispatch's own self-auth (which silently SKIPS when
 * SUDO_AI_DASHBOARD_TOKEN is unset). If no admin token is configured the
 * registrar refuses to mount (fail-closed), so the destructive routes can never
 * be reached unauthenticated.
 *
 * Irreversible routes are double-gated: even an authenticated caller gets 403 on
 * POST /api/admin/service/{restart,stop} and /api/admin/system/{backup,restore}
 * unless SUDO_ADMIN_API_DANGER=1 is also set.
 */

import type http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { adminRouter } from '../admin-router.js';
import { registerAdminHandlers } from './index.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('api:admin:register');

/** Method+path of the irreversible routes, gated behind SUDO_ADMIN_API_DANGER. */
const DANGER_ROUTES = new Set<string>([
  'POST /api/admin/service/restart', // process.exit(0)
  'POST /api/admin/service/stop',    // process.exit(1)
  'POST /api/admin/system/backup',   // tar of data + config
  'POST /api/admin/system/restore',  // overwrites live DBs
]);

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Constant-time Bearer check against the configured admin token. */
function isAuthorized(req: http.IncomingMessage, tokenBuf: Buffer): boolean {
  const header = (req.headers['authorization'] ?? '') as string;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const cand = Buffer.from(m[1]!.trim(), 'utf8');
  return cand.length === tokenBuf.length && timingSafeEqual(cand, tokenBuf);
}

/**
 * Attach the /api/admin/* listener to the gateway server.
 * @returns true if mounted, false if disabled (flag off) or fail-closed (no token).
 */
export async function registerAdminApi(server: http.Server): Promise<boolean> {
  if (process.env['SUDO_ADMIN_API'] !== '1') return false;

  const adminToken = (
    process.env['SUDO_AI_DASHBOARD_TOKEN'] || process.env['GATEWAY_TOKEN'] || ''
  ).trim();
  if (adminToken.length === 0) {
    log.error(
      'SUDO_ADMIN_API=1 but no admin token configured (SUDO_AI_DASHBOARD_TOKEN or GATEWAY_TOKEN). '
        + 'REFUSING to mount /api/admin/* — incl. POST /api/admin/service/restart (process.exit). '
        + 'Set SUDO_AI_DASHBOARD_TOKEN to enable.',
    );
    return false;
  }
  const tokenBuf = Buffer.from(adminToken, 'utf8');
  // Danger flag captured at mount time — a runtime change requires a restart
  // (intentional: the irreversible routes stay fail-closed until reboot).
  const dangerOn = process.env['SUDO_ADMIN_API_DANGER'] === '1';

  // Register the real handlers so they override the 501 stubs. Idempotent
  // (dynamic imports are deduped by the runtime module cache).
  await registerAdminHandlers();

  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (!path.startsWith('/api/admin')) return; // not ours — let other listeners / the 404 fallback handle it
    if (res.headersSent) return;

    const method = (req.method ?? 'GET').toUpperCase();

    // CORS preflight: no auth required; dispatch emits the 204.
    if (method === 'OPTIONS') {
      void adminRouter.dispatch(req, res).catch((err: unknown) => {
        log.error({ err }, 'admin OPTIONS dispatch threw');
        sendJson(res, 500, { error: { message: 'Internal server error', code: 500 } });
      });
      return;
    }

    // Auth gate — BEFORE dispatch, so unauthenticated callers never reach a handler.
    if (!isAuthorized(req, tokenBuf)) {
      sendJson(res, 401, { error: { message: 'Unauthorized', code: 401 } });
      return;
    }

    // Second gate: irreversible routes need an explicit extra opt-in.
    if (!dangerOn && DANGER_ROUTES.has(`${method} ${path}`)) {
      sendJson(res, 403, {
        error: { message: 'Danger route disabled — set SUDO_ADMIN_API_DANGER=1 to enable', code: 403 },
      });
      return;
    }

    void adminRouter
      .dispatch(req, res)
      .then((handled) => {
        if (!handled) sendJson(res, 404, { error: { message: 'Not found', code: 404 } });
      })
      .catch((err: unknown) => {
        log.error({ err }, 'admin dispatch threw');
        sendJson(res, 500, { error: { message: 'Internal server error', code: 500 } });
      });
  });

  log.warn(
    { dangerRoutesEnabled: dangerOn },
    'Admin API MOUNTED at /api/admin/* (Bearer token-gated). Irreversible routes '
      + '(service/restart, service/stop, system/backup, system/restore) '
      + (dangerOn ? 'are ENABLED (SUDO_ADMIN_API_DANGER=1).' : 'return 403 until SUDO_ADMIN_API_DANGER=1.'),
  );
  return true;
}
