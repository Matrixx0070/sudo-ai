/**
 * dashboard-routes.ts
 *
 * HTTP route handlers for the SUDO-AI dashboard.
 *
 * Read routes (GET, Bearer-gated):
 *   GET /              — Dashboard HTML UI (no auth)
 *   GET /api/stats     — DashboardStats JSON
 *   GET /api/health    — DashboardHealth JSON
 *   GET /api/metrics   — Prometheus text metrics
 *   GET /api/alignment — Alignment data
 *   GET /api/activity?limit=50 — Recent activity
 *   GET /api/agents/live — FleetView live agent snapshot (gap #25 slice 1)
 *   GET /api/admin/model — Current active LLM model (#28b slice 1)
 *
 * Admin-power READ routes (#28b slice 3 — Bearer-gated AND opt-in via SUDO_ADMIN_POWERS=1):
 *   GET /api/admin/credentials — vault namespace + entry metadata (no decryption)
 *   GET /api/admin/logs?lines=N — last N lines from the in-process ring buffer
 *   GET /api/admin/debug-share — single JSON support bundle (redacted)
 *
 * Admin-power routes (POST, Bearer-gated AND opt-in via SUDO_ADMIN_POWERS=1):
 *   POST /api/admin/restart    — process.exit(0); supervisor respawns
 *   POST /api/admin/update     — preview-by-default; dry_run=false applies
 *   POST /api/admin/model/set  — runtime model switch via Brain.setModel
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkHostHeader, type DashboardServer } from './dashboard-server.js';
import type { DashboardConfig } from './dashboard-types.js';
import { DASHBOARD_HTML } from './dashboard-html.js';

const log = {
  info: (msg: object) => {
    const timestamp = new Date().toISOString();
    process.stdout.write(`[${timestamp}] [dashboard-routes] ${JSON.stringify(msg)}\n`);
  },
  warn: (msg: object) => {
    const timestamp = new Date().toISOString();
    process.stderr.write(`[${timestamp}] [dashboard-routes] ${JSON.stringify(msg)}\n`);
  },
};

/** 256 KB body cap for POST handlers — matches admin-sleep-routes:19. */
const MAX_BODY = 256 * 1024;

// ---- Path → allowed-methods routing table (module-scope to avoid per-request alloc) ----
/** GET-only read routes. */
const GET_ROUTES: ReadonlySet<string> = new Set([
  '/api/stats',
  '/api/health',
  '/api/metrics',
  '/api/alignment',
  '/api/activity',
  '/api/agents/live',
  '/api/admin/model',
]);
/**
 * Admin-power READ routes (#28b slice 3) — GET, Bearer-gated AND opt-in via
 * SUDO_ADMIN_POWERS=1. Separate from GET_ROUTES so they share the
 * `adminPowersEnabled()` 503 gate with the POST mutation routes — the
 * common safety property is "no operator-level state leaves the box
 * unless the opt-in is set", regardless of HTTP method.
 *
 * Loopback-trust still applies to these GETs (same as `/api/admin/model`)
 * — see study doc 19:162-169 on the Hermes loopback-trust posture. The
 * three new endpoints surface no plaintext secrets (credentials returns
 * metadata only; debug-share applies key-name redaction; logs are
 * process stdout already visible via `/proc/N/fd/1` to anyone on the box).
 */
const ADMIN_GET_ROUTES: ReadonlySet<string> = new Set([
  '/api/admin/credentials',
  '/api/admin/logs',
  '/api/admin/debug-share',
]);
/** POST-only admin mutation routes (#28b slice 1) — Bearer-gated AND opt-in. */
const POST_ROUTES: ReadonlySet<string> = new Set([
  '/api/admin/restart',
  '/api/admin/update',
  '/api/admin/model/set',
]);

/**
 * Authenticate via the dashboard's resolved AuthBackend (pluggable; built-in
 * is `BasicAuthBackend` constructed from config.authToken). Slice 2 — Hermes
 * parity with `plugins/dashboard_auth/{basic,nous,self_hosted}/`.
 *
 * The `?token=` query-string fallback is GET-only — mutation POSTs require
 * a real Authorization header so the token never ends up in server access
 * logs, browser history, referrer headers, or shell history.
 */
function authenticateRequest(
  req: IncomingMessage,
  server: DashboardServer,
  opts: { allowQueryToken: boolean },
): { ok: true; principal: string } | { ok: false; reason: string } {
  return server.getAuthBackend().authenticate(req, opts);
}

/** Send JSON response. */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** Send plain text response. */
function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain'): void {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(text);
}

/** Accumulate the request body up to MAX_BODY; reject on overflow. */
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

/** Parse JSON body; returns {} for empty body, throws on malformed JSON. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Identifier for the audit actor on dashboard-driven mutations.
 *
 * Format: `dashboard:<principal>:<remote-ip>`. The principal comes from the
 * authenticated AuthBackend result (slice 2 — Hermes parity) — `basic` for
 * Bearer-only, `basic-query` for ?token= fallback, and future OAuth backends
 * will return per-user subject claims here. Remote IP is non-spoofable
 * because `req.socket.remoteAddress` ignores `X-Forwarded-For`.
 *
 * Earlier revisions embedded the last 6 chars of the auth token; that leaked
 * a usable token fragment into the chain-hashed audit log (forensics
 * shareability problem), so the token suffix is now omitted.
 */
function actorFor(req: IncomingMessage, principal: string): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  return `dashboard:${principal}:${remote}`;
}

/** Route handler registration. */
export function registerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  server: DashboardServer,
  config: DashboardConfig
): void {
  // Step 0a: Host-header allowlist (DNS-rebinding defense, slice 2). Applies
  // to ALL paths including the unauthenticated HTML root — if an attacker
  // tricks a victim browser into resolving `evil.com → 127.0.0.1`, the Host
  // header on those cross-origin fetches carries `evil.com`, not `localhost`,
  // and 403 fires before any route logic runs.
  //
  // Done FIRST — before `new URL(...)` — because a malformed/exotic Host can
  // make URL construction throw a TypeError, and we want the 403 to fire
  // without surfacing parse details to the attacker.
  if (!checkHostHeader(req.headers.host, server.getHostAllowlist())) {
    sendJson(res, 403, { error: 'Forbidden host' });
    return;
  }

  // Step 0b: parse URL only after the Host header has been validated.
  // Wrapped in try/catch defensively: even with the guard above, an attacker
  // who controls the allowlist via env (an operator misconfiguration) could
  // feed a hostname that still crashes the URL parser. Return 400 instead.
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    sendJson(res, 400, { error: 'Malformed request URL or Host' });
    return;
  }
  const pathname = url.pathname;
  const method = req.method ?? 'GET';

  // Route: Dashboard HTML (no auth required, GET only)
  if (method === 'GET' && pathname === '/') {
    sendText(res, 200, DASHBOARD_HTML, 'text/html');
    return;
  }

  // All /api/* routes require authentication (subject to loopback-trust)
  if (!pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const isKnownGet = GET_ROUTES.has(pathname);
  const isKnownAdminGet = ADMIN_GET_ROUTES.has(pathname);
  const isAnyGet = isKnownGet || isKnownAdminGet;
  const isKnownPost = POST_ROUTES.has(pathname);

  // Auth runs BEFORE the unknown-path 404 guard on purpose: unauthenticated
  // probes to non-existent routes return 401, not 404, so route names cannot
  // be enumerated without first passing the Bearer gate. Authenticated callers
  // hitting an unknown path still get 404 (the guard below).
  //
  // Loopback-trust (slice 2): when the dashboard is bound to 127.0.0.1 AND
  // the operator hasn't set `SUDO_DASHBOARD_INSECURE=1`, GET read routes skip
  // auth — matching Hermes's loopback-trust-by-default pattern (study doc 19).
  // Admin-power GETs (slice 3 — credentials/logs/debug-share) are eligible too
  // because they surface no plaintext secrets and anyone on the loopback face
  // can already read /proc/self/{environ,fd/1}. POST mutations ALWAYS require
  // auth regardless (mirrors how Hermes's /api/pty and /api/gateway/restart
  // still require auth even on loopback).
  let principal: string;
  const skipAuthForLoopbackGet = server.isLoopbackTrust() && method === 'GET' && isAnyGet;
  if (skipAuthForLoopbackGet) {
    principal = 'loopback-no-auth';
  } else {
    // allowQueryToken is true ONLY for known GET routes (both regular and
    // admin reads). Unknown paths and POST mutations both require an
    // Authorization header — the ?token= fallback is read-route ergonomics,
    // not a universal auth method.
    //
    // try/catch defends against a misbehaving custom AuthBackend throwing
    // out of `authenticate`. A throwing backend must not fall through to
    // the top-level 500 handler — treat throw as a denial.
    let authResult: ReturnType<typeof authenticateRequest>;
    try {
      authResult = authenticateRequest(req, server, { allowQueryToken: isAnyGet && !isKnownPost });
    } catch (err: unknown) {
      log.warn({ err: err instanceof Error ? err.message : String(err), msg: 'AuthBackend threw — treating as denial' });
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    if (!authResult.ok) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    principal = authResult.principal;
  }

  // Unknown path on any method → 404.
  if (!isAnyGet && !isKnownPost) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  // Opt-in gate runs BEFORE method-mismatch so an attacker who guesses an
  // admin path can't enumerate which HTTP verb is correct by reading the
  // 405-vs-503 split. Admin POST mutations and admin GET reads BOTH share
  // SUDO_ADMIN_POWERS=1, so a single check covers both classes. The shape
  // matches the slice-1 POST-mutation 503 so callers don't branch.
  //
  // `isKnownPost` is currently the same set as the admin POST mutation set
  // (POST_ROUTES contains only admin mutations); if a non-admin POST route
  // ever lands, split this gate into an explicit admin-POST subset.
  const isAnyAdminRoute = isKnownAdminGet || isKnownPost;
  if (isAnyAdminRoute && !server.adminPowersEnabled()) {
    sendJson(res, 503, { error: 'admin_powers_disabled', hint: 'Set SUDO_ADMIN_POWERS=1 to enable admin endpoints' });
    return;
  }

  // Method/path mismatch → 405. (e.g. POST /api/stats, GET /api/admin/restart)
  if (method === 'GET' && !isAnyGet) {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  if (method === 'POST' && !isKnownPost) {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  if (method !== 'GET' && method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // ---- GET dispatch -------------------------------------------------------
  if (method === 'GET') {
    if (pathname === '/api/stats') { sendJson(res, 200, server.getStats()); return; }
    if (pathname === '/api/health') { sendJson(res, 200, server.getHealth()); return; }
    if (pathname === '/api/metrics') {
      const metrics = server.getMetrics();
      const prometheusText = Object.entries(metrics).map(([key, value]) => `${key} ${value}`).join('\n');
      sendText(res, 200, prometheusText + '\n', 'text/plain; version=0.0.4');
      return;
    }
    if (pathname === '/api/alignment') { sendJson(res, 200, server.getAlignment()); return; }
    if (pathname === '/api/activity') {
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      sendJson(res, 200, server.getRecentActivity(limit));
      return;
    }
    if (pathname === '/api/agents/live') { sendJson(res, 200, server.getLiveAgents()); return; }
    if (pathname === '/api/admin/model') {
      const model = server.getCurrentModel();
      if (model === undefined) {
        sendJson(res, 503, { error: 'brain_not_registered' });
        return;
      }
      sendJson(res, 200, { model });
      return;
    }
    // ---- Admin-power READ dispatch (#28b slice 3) -----------------------
    // adminPowersEnabled() was already gated above for ADMIN_GET_ROUTES.
    const actor = actorFor(req, principal);
    if (pathname === '/api/admin/credentials') {
      sendJson(res, 200, server.getCredentialsMetadata(actor));
      return;
    }
    if (pathname === '/api/admin/logs') {
      const linesRaw = url.searchParams.get('lines');
      // Default 200 mirrors LogRing's own DEFAULT_USER_LINES_REQUEST. parseInt
      // returns NaN for non-numeric input; LogRing.tail() handles NaN by
      // re-defaulting + clamping internally, so we don't need a separate guard.
      const lines = linesRaw === null ? 200 : parseInt(linesRaw, 10);
      const result = server.getLogTail(actor, lines);
      if (!result.available) {
        sendJson(res, 503, result);
        return;
      }
      sendJson(res, 200, result);
      return;
    }
    if (pathname === '/api/admin/debug-share') {
      sendJson(res, 200, server.getDebugShareSnapshot(actor));
      return;
    }
    // Unreachable — pathname was vetted by `isKnownGet || isKnownAdminGet`
    // above. If a future path is added to either set without a matching
    // dispatch branch, throwing here surfaces the gap in the test suite
    // immediately instead of silently 404'ing in production.
    throw new Error(`unhandled GET dispatch: ${pathname}`);
  }

  // ---- POST dispatch (admin powers) ---------------------------------------
  // The SUDO_ADMIN_POWERS=1 opt-in gate runs above (before method-mismatch
  // and POST dispatch) so it cannot be bypassed by a method-mismatch probe.
  handleAdminPost(req, res, server, pathname, principal).catch((err: unknown) => {
    log.warn({ pathname, err: err instanceof Error ? err.message : String(err), msg: 'Admin POST rejected' });
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
  });
}

/** Dispatch a Bearer-authenticated, opt-in-enabled POST to its admin handler. */
async function handleAdminPost(
  req: IncomingMessage,
  res: ServerResponse,
  server: DashboardServer,
  pathname: string,
  principal: string,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Invalid body';
    sendJson(res, 400, { error: msg });
    return;
  }

  const actor = actorFor(req, principal);

  if (pathname === '/api/admin/restart') {
    const reason = typeof body['reason'] === 'string' ? (body['reason'] as string) : 'dashboard restart';
    const result = server.requestRestart(actor, reason);
    sendJson(res, 202, { accepted: true, ...result });
    return;
  }

  if (pathname === '/api/admin/update') {
    const channelRaw = body['channel'];
    const channel = typeof channelRaw === 'string' ? channelRaw : undefined;
    const dryRun = body['dry_run'] === false ? false : true; // default true
    if (dryRun) {
      const preview = await server.previewUpdate(channel, actor);
      sendJson(res, 200, preview);
      return;
    }
    const accepted = server.triggerUpdate(channel, actor);
    if (accepted.accepted) {
      sendJson(res, 202, accepted);
    } else {
      sendJson(res, 503, accepted);
    }
    return;
  }

  if (pathname === '/api/admin/model/set') {
    const target = body['model'];
    if (typeof target !== 'string' || target.length === 0) {
      sendJson(res, 400, { error: 'model must be a non-empty string' });
      return;
    }
    try {
      const now = server.switchModel(target, actor);
      sendJson(res, 200, { model: now });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === 'brain_not_registered' ? 503 : 400;
      sendJson(res, status, { error: message });
    }
    return;
  }

  // Should never reach here — pathname was vetted by caller.
  sendJson(res, 404, { error: 'Not found' });
}
