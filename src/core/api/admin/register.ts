/**
 * @file admin/register.ts
 * @description Mounts the AdminRouter (api/admin-router.ts + its handlers) onto
 * the gateway HTTP server, behind a fail-closed Bearer gate.
 *
 * Opt-in: SUDO_ADMIN_API=1. When unset, no listener is attached.
 *
 * GW-4 tail (route merge): the handler set is canonically served under
 * /v1/admin/*. Legacy /api/admin/* is a thin 308 redirect to the /v1/admin/*
 * equivalent, logged as DEPRECATED (throttled). Auth is enforced HERE, at the
 * gateway boundary, BEFORE adminRouter.dispatch — through the unified resolver
 * (gateway/auth.ts, operator.admin), the SAME boundary as the rest of
 * /v1/admin/*. If no admin token is configured the registrar refuses to mount
 * (fail-closed), so the destructive routes can never be reached unauthenticated.
 *
 * Irreversible routes are double-gated: even an authenticated caller gets 403 on
 * POST .../service/{restart,stop} and .../system/{backup,restore} unless
 * SUDO_ADMIN_API_DANGER=1 is also set.
 */

import type http from 'node:http';
import { adminRouter } from '../admin-router.js';
import { authenticateHttp, hasScope } from '../../gateway/auth.js';
import { registerAdminHandlers } from './index.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('api:admin:register');

/**
 * GW-4 tail: the adminRouter handler set is canonically served under
 * /v1/admin/*. These are the second-level namespaces it owns (disjoint from the
 * real /v1/admin/* audit/inspection/alignment routes in gateway/admin-routes.ts).
 * A /v1/admin path is served by THIS listener iff it falls under one of these.
 * `dashboard` is matched with a trailing slash so it never shadows the real
 * exact GET /v1/admin/dashboard (the HTML observability dashboard).
 */
const V1_STUB_NAMESPACES: readonly string[] = [
  '/v1/admin/dashboard/',
  '/v1/admin/service',
  '/v1/admin/models',
  '/v1/admin/channels',
  '/v1/admin/tools',
  '/v1/admin/consciousness',
  '/v1/admin/cron',
  '/v1/admin/settings',
  '/v1/admin/security',
  '/v1/admin/logs',
  '/v1/admin/system',
  '/v1/admin/sessions',
];

/** True if `path` is a /v1/admin path owned by the migrated adminRouter handler set. */
export function isMigratedAdminPath(path: string): boolean {
  return V1_STUB_NAMESPACES.some((ns) => path === ns || path.startsWith(ns));
}

// One deprecation log per section per 10 min — legacy /api/admin/* callers are
// noisy; we want a signal, not a flood.
const deprecationLoggedAt = new Map<string, number>();
function logApiAdminDeprecation(path: string): void {
  const key = path.split('/').slice(0, 4).join('/'); // /api/admin/<section>
  const now = Date.now();
  const last = deprecationLoggedAt.get(key) ?? 0;
  if (now - last < 600_000) return;
  deprecationLoggedAt.set(key, now);
  log.warn({ path: key }, 'DEPRECATED: /api/admin/* is retired — 308-redirecting to canonical /v1/admin/*. Update callers.');
}

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

/**
 * GW-4: authenticate through the unified resolver (gateway/auth.ts) requiring
 * operator.admin — the SAME boundary as /v1/admin/*. GATEWAY_TOKEN (or a
 * loopback-trusted request) grants operator.admin.
 */
function isAuthorized(req: http.IncomingMessage): boolean {
  const principal = authenticateHttp(req, { accept: ['gateway-token', 'loopback'] });
  return principal.ok && hasScope(principal, 'operator.admin');
}

/** Serve a request already normalized onto the canonical /api/admin/* pattern space. */
function serveAdmin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  canonicalPath: string,
  method: string,
  dangerOn: boolean,
): void {
  // CORS preflight: no auth required; dispatch emits the 204.
  if (method === 'OPTIONS') {
    void adminRouter.dispatch(req, res).catch((err: unknown) => {
      log.error({ err }, 'admin OPTIONS dispatch threw');
      sendJson(res, 500, { error: { message: 'Internal server error', code: 500 } });
    });
    return;
  }

  // Auth gate — BEFORE dispatch, so unauthenticated callers never reach a handler.
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: { message: 'Unauthorized', code: 401 } });
    return;
  }

  // Second gate: irreversible routes need an explicit extra opt-in.
  if (!dangerOn && DANGER_ROUTES.has(`${method} ${canonicalPath}`)) {
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
}

/**
 * Attach the admin listener to the gateway server. Serves the handler set under
 * canonical /v1/admin/* and 308-redirects legacy /api/admin/* to it.
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
        + 'REFUSING to mount admin API — incl. POST .../service/restart (process.exit). '
        + 'Set SUDO_AI_DASHBOARD_TOKEN to enable.',
    );
    return false;
  }
  // Danger flag captured at mount time — a runtime change requires a restart
  // (intentional: the irreversible routes stay fail-closed until reboot).
  const dangerOn = process.env['SUDO_ADMIN_API_DANGER'] === '1';

  // Register the real handlers so they override the 501 stubs. Idempotent
  // (dynamic imports are deduped by the runtime module cache).
  await registerAdminHandlers();

  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    const rawUrl = req.url ?? '/';
    const rawPath = rawUrl.split('?')[0] ?? '/';
    if (res.headersSent) return;

    const method = (req.method ?? 'GET').toUpperCase();

    // Legacy /api/admin/* → 308 redirect to the canonical /v1/admin/* path
    // (method + body preserved). Logged as DEPRECATED (throttled).
    if (rawPath.startsWith('/api/admin')) {
      logApiAdminDeprecation(rawPath);
      const location = '/v1/admin' + rawUrl.slice('/api/admin'.length);
      res.writeHead(308, { Location: location });
      res.end();
      return;
    }

    // Canonical /v1/admin/<migrated namespace> — served by the adminRouter set.
    // Not ours (real audit/inspection routes, or anything else) → fall through.
    if (!isMigratedAdminPath(rawPath)) return;

    // Rewrite onto the adminRouter's /api/admin pattern space for matching.
    const canonicalUrl = '/api/admin' + rawUrl.slice('/v1/admin'.length);
    req.url = canonicalUrl;
    const canonicalPath = canonicalUrl.split('?')[0] ?? canonicalUrl;
    serveAdmin(req, res, canonicalPath, method, dangerOn);
  });

  log.warn(
    { dangerRoutesEnabled: dangerOn },
    'Admin API MOUNTED — canonical /v1/admin/* (legacy /api/admin/* 308-redirects here, DEPRECATED). '
      + 'Unified operator.admin auth. Irreversible routes '
      + '(service/restart, service/stop, system/backup, system/restore) '
      + (dangerOn ? 'are ENABLED (SUDO_ADMIN_API_DANGER=1).' : 'return 403 until SUDO_ADMIN_API_DANGER=1.'),
  );
  return true;
}
