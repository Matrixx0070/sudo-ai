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
import {
  checkHostHeader,
  getRegisteredFleetRegistrar,
  getRegisteredFleetNonceStore,
  type DashboardServer,
} from './dashboard-server.js';
import type { DashboardConfig } from './dashboard-types.js';
import { DASHBOARD_HTML } from './dashboard-html.js';
import { verifyRegistrationRequest } from '../fleet/registration.js';
import { verifyFleetRequest } from '../fleet/fleet-signature.js';
import {
  type CommandBody,
  type CommandKind,
  type CommandResult,
} from '../fleet/command-queue.js';
import type { FleetCommandRow } from './dashboard-types.js';
import { createHash, createPublicKey } from 'node:crypto';

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
  '/api/admin/fleet/devices',
]);
/** POST-only admin mutation routes (#28b slice 1) — Bearer-gated AND opt-in. */
const POST_ROUTES: ReadonlySet<string> = new Set([
  '/api/admin/restart',
  '/api/admin/update',
  '/api/admin/model/set',
  '/api/admin/fleet/dispatch',
]);

/**
 * Dynamic admin POST prefixes (#28c slice 4). Each matched by both startsWith
 * AND a specific suffix; pathname `/api/admin/fleet/devices/<id>/admit` →
 * one match, `/admit` action. The set is small + each entry shares the
 * SUDO_ADMIN_POWERS=1 gate.
 */
const ADMIN_POST_PREFIXES: readonly { prefix: string; suffix: string }[] = [
  { prefix: '/api/admin/fleet/devices/', suffix: '/admit' },
  { prefix: '/api/admin/fleet/devices/', suffix: '/revoke' },
];

function isAdminPostPrefix(pathname: string): boolean {
  return ADMIN_POST_PREFIXES.some((p) => pathname.startsWith(p.prefix) && pathname.endsWith(p.suffix));
}

/**
 * Dynamic admin GET paths (#28c slice 2). Each is a `startsWith` test —
 * the path is parsed to extract a route param. Tested AFTER ADMIN_GET_ROUTES
 * + before the unknown-path 404. Shares the SUDO_ADMIN_POWERS=1 opt-in.
 *
 * Slice 3 adds `/api/admin/fleet/devices/<id>/commands` for the per-device
 * command-history panel. The prefix order matters — both start with
 * `/api/admin/fleet/`; the per-device path includes `/commands` AT THE END
 * so we match it with an explicit endsWith check below.
 */
const ADMIN_GET_PREFIXES: readonly string[] = [
  '/api/admin/fleet/commands/',
  '/api/admin/fleet/devices/',
];

/**
 * Dynamic public POST/GET paths (#28c slice 2) — device back-channel.
 * Signature-gated (per-request Ed25519 verified against the device's stored
 * publicKey). Match by prefix, handle internally.
 */
const PUBLIC_FLEET_DEVICE_PREFIX = '/api/fleet/device/';

/**
 * Public POST routes (#28c slice 1) — bypass Bearer/OAuth auth. Currently
 * only `/api/fleet/register`, where the request's Ed25519 signature IS the
 * auth (verified against the embedded public key + payload).
 *
 * Host-header allowlist still applies (runs at step 0a, before this set is
 * consulted). When registrar mode is OFF (no FleetRegistrarSource registered),
 * the route returns 503 from inside the handler — there is no separate
 * routing-table-level gate, so an attacker can't enumerate "registrar
 * enabled?" via the 404-vs-405-vs-503 split.
 */
const PUBLIC_POST_ROUTES: ReadonlySet<string> = new Set([
  '/api/fleet/register',
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
async function authenticateRequest(
  req: IncomingMessage,
  server: DashboardServer,
  opts: { allowQueryToken: boolean },
): Promise<{ ok: true; principal: string } | { ok: false; reason: string }> {
  // The interface allows sync `AuthResult` OR `Promise<AuthResult>` (slice 4
  // widening for OAuth). `await` collapses both cases — sync backends pay no
  // measurable overhead because the microtask hop is a single V8 frame.
  return await server.getAuthBackend().authenticate(req, opts);
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

/**
 * Route handler registration. Async since slice 4 — OAuth/JWT backends can
 * verify RS256 signatures via `crypto.verify`, which is callback-/promise-
 * based when used with PEM-encoded keys. Sync Bearer auth keeps working
 * because `await Promise.resolve(syncResult)` collapses in one microtask.
 *
 * Callers (DashboardServer.start, tests) must handle the returned Promise —
 * they may either `.catch(...)` rejections or simply ignore the Promise (the
 * function itself returns 500 on any internal throw before resolving).
 */
export async function registerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  server: DashboardServer,
  config: DashboardConfig
): Promise<void> {
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

  // -------------------------------------------------------------------------
  // PUBLIC POST routes (#28c slice 1) — bypass Bearer/OAuth auth because the
  // request's Ed25519 signature IS the auth. Handled BEFORE the auth gate so
  // devices that don't share the dashboard's Bearer token can still register.
  // The Host-header allowlist still ran above (step 0a). When registrar mode
  // is off, the handler returns 503 — no separate enumeration of the gate.
  // -------------------------------------------------------------------------
  if (method === 'POST' && PUBLIC_POST_ROUTES.has(pathname)) {
    if (pathname === '/api/fleet/register') {
      handleFleetRegister(req, res).catch((err: unknown) => {
        log.warn({ err: err instanceof Error ? err.message : String(err), msg: 'Fleet register handler threw' });
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      });
      return;
    }
  }

  // Slice 4 — public GET /api/fleet/challenge — emits a single-use nonce
  // the device must echo in the registration payload (replay-window hardening).
  // No auth — anyone can request a nonce; consumption is tied to deviceId +
  // requires a valid Ed25519 signature on the subsequent /register POST.
  if (method === 'GET' && pathname === '/api/fleet/challenge') {
    handleFleetChallenge(req, res, url).catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), msg: 'Fleet challenge handler threw' });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    });
    return;
  }

  // Public device back-channel (#28c slice 2). Two routes, both dynamic on
  // :deviceId, both signature-gated. Like /register above, public means
  // "no Bearer/OAuth" — the per-request Ed25519 signature is the auth.
  if (pathname.startsWith(PUBLIC_FLEET_DEVICE_PREFIX)) {
    handleFleetDeviceBackChannel(req, res, pathname, method).catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), msg: 'Fleet back-channel handler threw' });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    });
    return;
  }

  const isKnownGet = GET_ROUTES.has(pathname);
  const isAdminGetPrefix = ADMIN_GET_PREFIXES.some((p) => pathname.startsWith(p));
  const isKnownAdminGet = ADMIN_GET_ROUTES.has(pathname) || isAdminGetPrefix;
  const isAnyGet = isKnownGet || isKnownAdminGet;
  const isKnownPost = POST_ROUTES.has(pathname) || isAdminPostPrefix(pathname);

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
    let authResult: Awaited<ReturnType<typeof authenticateRequest>>;
    try {
      authResult = await authenticateRequest(req, server, { allowQueryToken: isAnyGet && !isKnownPost });
    } catch (err: unknown) {
      // Sync throw OR rejected Promise from a misbehaving backend — both
      // bubble through the same `await` and collapse to a denial.
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
    if (pathname.startsWith('/api/admin/fleet/devices/') && pathname.endsWith('/commands')) {
      // Slice 3 — per-device command history for the admin UI panel.
      const queue = getCommandQueueOrUndefined();
      const registrar = getRegisteredFleetRegistrar();
      if (!queue || !registrar) {
        sendJson(res, 503, { error: 'fleet_registrar_not_enabled' });
        return;
      }
      // Extract :deviceId from `/api/admin/fleet/devices/<id>/commands`.
      const prefix = '/api/admin/fleet/devices/';
      const deviceId = pathname.slice(prefix.length, pathname.length - '/commands'.length);
      if (deviceId.length === 0 || deviceId.includes('/')) {
        sendJson(res, 400, { error: 'invalid_device_id' });
        return;
      }
      if (!registrar.list().some((d) => d.deviceId === deviceId)) {
        sendJson(res, 404, { error: 'device_not_registered' });
        return;
      }
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw === null ? 50 : parseInt(limitRaw, 10);
      const rows = queue.listForDevice(deviceId, Number.isFinite(limit) ? limit : 50);
      sendJson(res, 200, { deviceId, count: rows.length, commands: rows.map(projectCommand) });
      return;
    }
    if (pathname.startsWith('/api/admin/fleet/commands/')) {
      const queue = getCommandQueueOrUndefined();
      if (!queue) {
        sendJson(res, 503, { error: 'fleet_registrar_not_enabled' });
        return;
      }
      const commandId = pathname.slice('/api/admin/fleet/commands/'.length);
      if (commandId.length === 0 || commandId.includes('/')) {
        sendJson(res, 400, { error: 'invalid_command_id' });
        return;
      }
      const row = queue.get(commandId);
      if (!row) {
        sendJson(res, 404, { error: 'command_not_found' });
        return;
      }
      sendJson(res, 200, projectCommand(row));
      return;
    }
    if (pathname === '/api/admin/fleet/devices') {
      const registrar = getRegisteredFleetRegistrar();
      if (!registrar) {
        sendJson(res, 503, {
          error: 'fleet_registrar_not_enabled',
          hint: 'Set SUDO_FLEET_REGISTRAR_MODE=1 to enable the fleet registrar',
        });
        return;
      }
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw === null ? 100 : parseInt(limitRaw, 10);
      // Audit the read with non-secret metadata only (count, limit, actor).
      const devices = registrar.list(Number.isFinite(limit) ? limit : 100);
      server.appendFleetReadAudit(actor, devices.length, Number.isFinite(limit) ? limit : 100);
      // metadata_json is an opaque JSON blob; parse defensively (a row from
      // an older slice could have a malformed value and we don't want a
      // single bad row to 500 the whole list endpoint).
      const projected = devices.map((d) => ({
        deviceId: d.deviceId,
        hostname: d.hostname,
        versionStr: d.versionStr,
        firstRegisteredAt: d.firstRegisteredAt,
        lastRegisteredAt: d.lastRegisteredAt,
        // Slice 4 — heartbeat + admission state. lastSeenAt is null for
        // devices that haven't yet polled (post-register, pre-first-inbox).
        lastSeenAt: d.lastSeenAt,
        admissionStatus: d.admissionStatus,
        publicKeyFingerprint: publicKeyFingerprint(d.publicKeyPem),
        metadata: parseMetadataJsonSafe(d.metadataJson),
      }));
      sendJson(res, 200, { count: projected.length, devices: projected });
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

  if (pathname === '/api/admin/fleet/dispatch') {
    const registrar = getRegisteredFleetRegistrar();
    const queue = getCommandQueueOrUndefined();
    if (!registrar || !queue) {
      sendJson(res, 503, { error: 'fleet_registrar_not_enabled' });
      return;
    }
    const deviceId = body['deviceId'];
    const cmd = body['command'];
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      sendJson(res, 400, { error: 'deviceId required' });
      return;
    }
    if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) {
      sendJson(res, 400, { error: 'command must be an object with `kind`' });
      return;
    }
    const kind = (cmd as Record<string, unknown>)['kind'];
    if (typeof kind !== 'string' || !isSupportedCommandKind(kind)) {
      sendJson(res, 400, { error: 'unsupported_command_kind', supported: SUPPORTED_KINDS });
      return;
    }
    const targetDevice = registrar.list().find((d) => d.deviceId === deviceId);
    if (!targetDevice) {
      sendJson(res, 404, { error: 'device_not_registered' });
      return;
    }
    // Slice 4 — refuse dispatch to a revoked device. The admin who revoked
    // it intentionally cut its access; queueing a command for it would just
    // sit forever (the device's inbox poll already returns 403).
    if (targetDevice.admissionStatus === 'revoked') {
      sendJson(res, 403, { error: 'device_revoked' });
      return;
    }
    const argsRaw = (cmd as Record<string, unknown>)['args'];
    const args = argsRaw && typeof argsRaw === 'object' && !Array.isArray(argsRaw)
      ? (argsRaw as Record<string, unknown>)
      : undefined;
    const command: CommandBody = { kind: kind as CommandKind, ...(args ? { args } : {}) };
    const commandId = queue.enqueue({ deviceId, command, dispatcher: actor });
    server.appendFleetDispatchAudit(actor, deviceId, commandId, kind);
    sendJson(res, 202, { ok: true, commandId });
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

  // Slice 4 — admission state transitions.
  // POST /api/admin/fleet/devices/<id>/{admit,revoke}
  if (pathname.startsWith('/api/admin/fleet/devices/') &&
      (pathname.endsWith('/admit') || pathname.endsWith('/revoke'))) {
    const registrar = getRegisteredFleetRegistrar();
    if (!registrar) {
      sendJson(res, 503, { error: 'fleet_registrar_not_enabled' });
      return;
    }
    const action = pathname.endsWith('/admit') ? 'admit' : 'revoke';
    const target: 'approved' | 'revoked' = action === 'admit' ? 'approved' : 'revoked';
    const suffix = action === 'admit' ? '/admit' : '/revoke';
    const deviceId = pathname.slice('/api/admin/fleet/devices/'.length, pathname.length - suffix.length);
    if (deviceId.length === 0 || deviceId.includes('/')) {
      sendJson(res, 400, { error: 'invalid_device_id' });
      return;
    }
    const updated = registrar.setAdmissionStatus(deviceId, target);
    if (!updated) {
      sendJson(res, 404, { error: 'device_not_registered' });
      return;
    }
    server.appendFleetAdmissionAudit(actor, deviceId, target);
    sendJson(res, 200, { ok: true, deviceId, admissionStatus: updated.admissionStatus });
    return;
  }

  // Should never reach here — pathname was vetted by caller.
  sendJson(res, 404, { error: 'Not found' });
}

/**
 * Handle `POST /api/fleet/register` (#28c slice 1). Public — no Bearer/OAuth.
 * The Ed25519 signature over the canonical payload IS the auth. Verified
 * against the embedded publicKey + deviceId = hash(publicKey) check +
 * 5-minute replay window. When registrar mode is off, returns 503 so
 * an attacker can't enumerate the gate via a 404-vs-503 split.
 */
async function handleFleetRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const registrar = getRegisteredFleetRegistrar();
  if (!registrar) {
    sendJson(res, 503, {
      error: 'fleet_registrar_not_enabled',
      hint: 'Set SUDO_FLEET_REGISTRAR_MODE=1 on the registrar to accept device registrations',
    });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err: unknown) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
    return;
  }

  const nonceStore = getRegisteredFleetNonceStore();
  if (!nonceStore) {
    sendJson(res, 503, { error: 'fleet_registrar_not_enabled', reason: 'nonce_store_missing' });
    return;
  }
  const verifyResult = verifyRegistrationRequest(body, { nonceStore });
  if (!verifyResult.ok) {
    // Specific reason lands in the response so a legitimate device that
    // misconfigured can debug. An attacker spamming random POSTs already
    // failed the signature check, so the leak surface is minimal.
    sendJson(res, 400, { error: 'invalid_registration', reason: verifyResult.reason });
    return;
  }

  const payload = verifyResult.payload;
  try {
    const row = registrar.upsert({
      deviceId: payload.deviceId,
      publicKeyPem: payload.publicKeyPem,
      hostname: payload.hostname,
      versionStr: payload.version_str,
      ...(payload.metadata ? { metadata: payload.metadata } : {}),
    });
    sendJson(res, 200, {
      ok: true,
      deviceId: row.deviceId,
      registeredAt: row.lastRegisteredAt,
    });
  } catch (err: unknown) {
    log.warn({ err: err instanceof Error ? err.message : String(err), deviceId: payload.deviceId, msg: 'Fleet upsert failed' });
    sendJson(res, 500, { error: 'persist_failed' });
  }
}

/**
 * Slice 4 — public GET /api/fleet/challenge?deviceId=<id>. Issues a
 * single-use nonce + expiry, scoped to the deviceId. The device must echo
 * this nonce in its subsequent `POST /register` payload.
 *
 * 400 when `deviceId` is missing/invalid. 503 when nonce store / registrar
 * not enabled. 200 on success.
 */
async function handleFleetChallenge(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  // Mirror /register's gate: if the operator doesn't have registrar mode on,
  // there's nothing to challenge for. 503 keeps gate-enumeration symmetric
  // with the rest of the slice 1 + 2 fleet routes.
  const registrar = getRegisteredFleetRegistrar();
  const nonceStore = getRegisteredFleetNonceStore();
  if (!registrar || !nonceStore) {
    sendJson(res, 503, { error: 'fleet_registrar_not_enabled' });
    return;
  }

  const deviceId = url.searchParams.get('deviceId');
  if (!deviceId || deviceId.length === 0) {
    sendJson(res, 400, { error: 'deviceId required' });
    return;
  }
  // Cheap structural sanity — deviceId is 16 hex chars from
  // `computeDeviceId`. Reject anything with whitespace or path separators
  // before stamping a row.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) {
    sendJson(res, 400, { error: 'invalid_device_id' });
    return;
  }
  const issued = nonceStore.issue(deviceId);
  sendJson(res, 200, {
    nonce: issued.nonce,
    expiresAtMs: issued.expiresAtMs,
  });
}

/** Short SHA-256 fingerprint of a public-key PEM, for the admin list view. */
function publicKeyFingerprint(publicKeyPem: string): string {
  try {
    const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(der).digest('hex').slice(0, 16);
  } catch {
    return '(invalid-pem)';
  }
}

/** Slice-2 command kinds the admin dispatch endpoint accepts. */
const SUPPORTED_KINDS: readonly CommandKind[] = ['model.get', 'model.set'];
function isSupportedCommandKind(s: string): boolean {
  return (SUPPORTED_KINDS as readonly string[]).includes(s);
}

/**
 * Public device back-channel handler — covers both:
 *   - GET  /api/fleet/device/:id/inbox?wait=<seconds>
 *   - POST /api/fleet/device/:id/result
 *
 * Both signature-gated. Returns 503 when the queue isn't enabled, 404 for
 * unknown deviceId, 400 for malformed paths, 401 for bad signatures.
 */
async function handleFleetDeviceBackChannel(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
): Promise<void> {
  const registrar = getRegisteredFleetRegistrar();
  const queue = getCommandQueueOrUndefined();
  if (!registrar || !queue) {
    sendJson(res, 503, { error: 'fleet_registrar_not_enabled' });
    return;
  }

  // Path: /api/fleet/device/{id}/{inbox|result}
  // Slice 1's PUBLIC_FLEET_DEVICE_PREFIX matched only the prefix; parse out
  // the segments here.
  const rest = pathname.slice('/api/fleet/device/'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) {
    sendJson(res, 400, { error: 'invalid_path' });
    return;
  }
  const deviceId = rest.slice(0, slash);
  const action = rest.slice(slash + 1);
  if (action !== 'inbox' && action !== 'result') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const device = registrar.list().find((d) => d.deviceId === deviceId);
  if (!device) {
    sendJson(res, 404, { error: 'device_not_registered' });
    return;
  }

  const verify = verifyFleetRequest({
    method,
    path: pathname,
    headers: req.headers as Record<string, string | string[] | undefined>,
    expectedDeviceId: deviceId,
    storedPublicKeyPem: device.publicKeyPem,
  });
  if (!verify.ok) {
    sendJson(res, 401, { error: 'unauthorized', reason: verify.reason });
    return;
  }

  // Slice 4 — refuse revoked devices. Sig + identity all check out, but the
  // admin has explicitly revoked this device's access. Returns 403 so the
  // device sees it's been deliberately blocked, not just misconfigured.
  if (device.admissionStatus === 'revoked') {
    sendJson(res, 403, { error: 'device_revoked' });
    return;
  }

  if (action === 'inbox') {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    // Slice 4 — bump heartbeat. This is the highest-frequency device→
    // registrar interaction (every ~25s under normal long-poll), so it's
    // the canonical "device is alive" signal. Best-effort; a registry
    // throw on update is non-fatal (the rest of the inbox flow continues).
    try {
      registrar.setLastSeen(deviceId);
    } catch { /* heartbeat is best-effort */ }
    const url = new URL(pathname + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''), 'http://localhost');
    const waitSecRaw = url.searchParams.get('wait');
    const waitSec = waitSecRaw === null ? 25 : parseInt(waitSecRaw, 10);
    // Clamp wait to [0, 60]. 0 = no long-poll (immediate return). 60 = HTTP
    // client safety margin under most idle timeouts.
    const waitMs = Math.max(0, Math.min(60, Number.isFinite(waitSec) ? waitSec : 25)) * 1000;
    const row = waitMs === 0 ? queue.pickup(deviceId) : await queue.pickupLongPoll(deviceId, waitMs);
    if (!row) {
      // 204 — no command for this poll cycle. Device should re-poll.
      res.writeHead(204);
      res.end();
      return;
    }
    sendJson(res, 200, projectCommand(row));
    return;
  }

  // action === 'result'
  if (method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err: unknown) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
    return;
  }
  const commandId = body['commandId'];
  const statusRaw = body['status'];
  if (typeof commandId !== 'string' || commandId.length === 0) {
    sendJson(res, 400, { error: 'commandId required' });
    return;
  }
  if (statusRaw !== 'completed' && statusRaw !== 'failed') {
    sendJson(res, 400, { error: 'status must be completed|failed' });
    return;
  }
  const existing = queue.get(commandId);
  if (!existing) {
    sendJson(res, 404, { error: 'command_not_found' });
    return;
  }
  if (existing.deviceId !== deviceId) {
    // A different device is trying to claim a result. Signature would have
    // failed too (we verified above for `deviceId`), but defense in depth.
    sendJson(res, 403, { error: 'device_id_mismatch' });
    return;
  }
  const result: CommandResult = {
    status: statusRaw,
    ...(body['result'] !== undefined ? { result: body['result'] } : {}),
    ...(typeof body['error'] === 'string' ? { error: body['error'] as string } : {}),
  };
  const updated = queue.complete({ commandId, result });
  if (!updated) {
    // Either already completed (idempotent retry) or not in_flight.
    sendJson(res, 409, { error: 'command_not_in_flight', status: existing.status });
    return;
  }
  sendJson(res, 200, { ok: true, status: updated.status });
}

/** Strip server-internal columns from a command row for over-the-wire JSON. */
function projectCommand(row: FleetCommandRow): Record<string, unknown> {
  return {
    commandId: row.commandId,
    deviceId: row.deviceId,
    kind: row.kind,
    args: row.argsJson ? safeJsonParse(row.argsJson) : undefined,
    status: row.status,
    dispatchedAt: row.dispatchedAt,
    pickedUpAt: row.pickedUpAt,
    completedAt: row.completedAt,
    result: row.resultJson ? safeJsonParse(row.resultJson) : undefined,
    error: row.errorMessage ?? undefined,
  };
}
function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Look up the registered CommandQueue, if any. The queue is registered
 * alongside the registry in `registerDashboardGlobals` — both come up
 * together when SUDO_FLEET_REGISTRAR_MODE=1.
 */
function getCommandQueueOrUndefined(): import('./dashboard-types.js').FleetCommandQueueSource | undefined {
  const g = globalThis as { __sudoFleetCommandQueue?: import('./dashboard-types.js').FleetCommandQueueSource };
  return g.__sudoFleetCommandQueue;
}

/** Parse a stored metadata_json blob safely; bad rows return null. */
function parseMetadataJsonSafe(json: string | null): Record<string, string> | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}
