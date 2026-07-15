/**
 * gateway/synth-probe-routes.ts — POST /v1/admin/synth-probe
 *
 * Measures real synth-path latency by invoking probeSynthesize() with a
 * HARDCODED benign proposal — no LLM call, no hot-load, no user input
 * forwarded to the synthesizer.
 *
 * Auth:        Bearer token (same pattern as bench-routes.ts)
 * Kill-switch: SUDO_TOOL_SYNTHESIZE_ENABLED must be '1', else 503
 * Rate limit:  5 calls per 60s per token (hash-of-bearer or IP fallback)
 *
 * Response:
 *   200  { ok: boolean, duration_ms: number, errorCode?: string, phase?: string }
 *   401  Unauthorized
 *   429  { error: { message, code } } + Retry-After header
 *   503  { error: 'synthesize disabled', code: 'SYNTH_DISABLED' }
 */

import { createHash } from 'node:crypto';
import { authenticateHttp } from './auth.js';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { metrics } from '../health/metrics.js';
import { probeSynthesize, sanitizeErrorCode } from '../tools/builtin/meta/tool-synthesize.js';

const log = createLogger('gateway:synth-probe-routes');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROBE_RL_WINDOW_MS  = 60_000;
const PROBE_RL_MAX        = 5;
const MAX_BODY            = 1_024;   // 1 KB — we ignore body but must drain socket
const MAX_RL_ENTRIES      = 1_000;   // MEDIUM-1: cap Map size to bound memory use
const MAX_CONCURRENT_PROBES = 2;    // LOW-2: cap concurrent bwrap spawns (~50MB each)

// ---------------------------------------------------------------------------
// Auth helpers (self-contained, no side-effects)
// ---------------------------------------------------------------------------

function extractBearer(req: IncomingMessage): string {
  const h = req.headers['authorization'] ?? '';
  if (typeof h !== 'string') return '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? (m[1] ?? '') : '';
}

// isAuthorised removed — auth centralised in ./auth.ts (authenticateHttp).

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

function sendError(res: ServerResponse, status: number, message: string, extra?: Record<string, unknown>): void {
  sendJson(res, status, { error: Object.assign({ message, code: status }, extra ?? {}) });
}

/** Drain (and discard) request body — avoids socket backpressure hangs. */
async function drainBody(req: IncomingMessage): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) { req.destroy(); resolve(); }
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Sliding-window rate limiter — 5 calls / 60s per token (sha256-hashed) or IP
// ---------------------------------------------------------------------------

const _probeRlWindows = new Map<string, number[]>();
let _lastEvictionWarnAt = 0;  // MEDIUM-1: throttle eviction warn to once/min
let _activeProbes = 0;        // LOW-2: concurrency counter

function checkProbeRateLimit(req: IncomingMessage): { allowed: boolean; retryAfterSec: number } {
  const bearer = extractBearer(req);
  const key = bearer.length > 0
    ? `token:${createHash('sha256').update(bearer).digest('hex')}`
    : `ip:${req.socket.remoteAddress ?? 'unknown'}`;

  const now = Date.now();

  // Evict fully-expired buckets to prevent unbounded Map growth
  for (const [k, ts] of _probeRlWindows) {
    if (ts.every((t) => now - t >= PROBE_RL_WINDOW_MS)) {
      _probeRlWindows.delete(k);
    }
  }

  const timestamps = (_probeRlWindows.get(key) ?? []).filter((t) => now - t < PROBE_RL_WINDOW_MS);

  // MEDIUM-1: delete empty-array entries immediately to prevent slow leak
  if (timestamps.length === 0 && _probeRlWindows.has(key)) {
    _probeRlWindows.delete(key);
  }

  // MEDIUM-1: enforce hard cap — evict oldest insertion-order entry if at cap
  if (!_probeRlWindows.has(key) && _probeRlWindows.size >= MAX_RL_ENTRIES) {
    const oldestKey = _probeRlWindows.keys().next().value;
    if (oldestKey !== undefined) {
      _probeRlWindows.delete(oldestKey);
      if (now - _lastEvictionWarnAt >= 60_000) {
        _lastEvictionWarnAt = now;
        console.warn('synth-probe rate-limit map at cap — evicting oldest key');
      }
    }
  }

  if (timestamps.length >= PROBE_RL_MAX) {
    const oldest = timestamps[0]!;
    const retryAfterSec = Math.ceil((PROBE_RL_WINDOW_MS - (now - oldest)) / 1000);
    log.warn({ key, count: timestamps.length }, 'synth-probe rate limit exceeded');
    return { allowed: false, retryAfterSec };
  }

  timestamps.push(now);
  _probeRlWindows.set(key, timestamps);
  return { allowed: true, retryAfterSec: 0 };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleSynthProbe(req: IncomingMessage, res: ServerResponse, tokenBuf: Buffer | null): Promise<void> {
  // 1. Auth
  if (!authenticateHttp(req, { secretOverride: tokenBuf }).ok) {
    sendError(res, 401, 'Unauthorized: invalid or missing bearer token');
    return;
  }

  // 2. Kill-switch check BEFORE rate limit — don't burn RL budget when disabled
  if (process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'] !== '1') {
    sendJson(res, 503, { error: 'synthesize disabled', code: 'SYNTH_DISABLED' });
    return;
  }

  // 3. Rate limit
  const rl = checkProbeRateLimit(req);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfterSec));
    sendError(res, 429, `Rate limit exceeded — retry after ${rl.retryAfterSec}s`);
    return;
  }

  // 4. Concurrency cap — each probe spawns a bwrap child (~50MB RAM)
  if (_activeProbes >= MAX_CONCURRENT_PROBES) {
    res.setHeader('Retry-After', '2');
    sendError(res, 429, 'probe concurrency limit', { code: 'PROBE_CONCURRENCY_LIMIT', retryAfter: 2 });
    return;
  }

  // 5. Drain body (ignored — input is never forwarded to synth path)
  try { await drainBody(req); } catch { /* ignore drain errors */ }

  // 6. Invoke probe (concurrency counter wraps the bwrap spawn only)
  metrics.increment('synth_probe_total');

  let result: Awaited<ReturnType<typeof probeSynthesize>>;
  try {
    _activeProbes++;  // LOW-2: inside try so counter doesn't leak on pre-try throws
    result = await probeSynthesize();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'synth-probe unhandled error');
    metrics.increment('synth_probe_failure_total');
    sendError(res, 500, 'Internal server error');
    return;
  } finally {
    _activeProbes--;
  }

  metrics.timing('synth_probe_duration_ms', result.duration_ms);
  if (result.ok) {
    metrics.increment('synth_probe_success_total');
    log.info({ duration_ms: result.duration_ms }, 'synth-probe ok');
  } else {
    metrics.increment('synth_probe_failure_total');
    log.warn({ duration_ms: result.duration_ms, errorCode: result.errorCode, phase: result.phase }, 'synth-probe failed');
  }

  const body: Record<string, unknown> = {
    ok: result.ok,
    duration_ms: Math.round(result.duration_ms),
  };
  if (!result.ok) {
    // LOW-1: sanitize errorCode before surfacing in API response (path leak prevention)
    if (result.errorCode) body['errorCode'] = sanitizeErrorCode(result.errorCode);
    if (result.phase) body['phase'] = result.phase;
  }

  sendJson(res, 200, body);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register POST /v1/admin/synth-probe on the provided http.Server.
 * The /v1/admin fallthrough is already declared in http-api.ts, so no
 * additional server.ts entry is needed.
 */
export function registerSynthProbeRoutes(server: HttpServer, tokenBuf: Buffer | null): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method   = req.method ?? '';
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';

    if (method !== 'POST' || pathname !== '/v1/admin/synth-probe') return;

    handleSynthProbe(req, res, tokenBuf).catch((err: unknown) => {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Unhandled error in handleSynthProbe');
      if (!res.headersSent) sendError(res, 500, 'Internal server error');
    });
  });

  log.info('Synth-probe route registered (POST /v1/admin/synth-probe)');
}

// ---------------------------------------------------------------------------
// Test-only exports (white-box access for PROBE-6/PROBE-8 tests)
// Guarded by NODE_ENV — unavailable in production to prevent in-process abuse.
// ---------------------------------------------------------------------------

const _TEST_ONLY_DISABLED = (): never => { throw new Error('_testOnly_* exports disabled outside test env'); };

/** @internal — exposed for unit tests only */
export function _testOnly_getRlMap(): Map<string, number[]> {
  if (process.env['NODE_ENV'] !== 'test') _TEST_ONLY_DISABLED();
  return _probeRlWindows;
}
/** @internal — exposed for unit tests only */
export function _testOnly_getActiveProbes(): number {
  if (process.env['NODE_ENV'] !== 'test') _TEST_ONLY_DISABLED();
  return _activeProbes;
}
/** @internal — exposed for unit tests only */
export function _testOnly_setActiveProbes(n: number): void {
  if (process.env['NODE_ENV'] !== 'test') _TEST_ONLY_DISABLED();
  _activeProbes = n;
}
/** @internal — exposed for unit tests only */
export function _testOnly_clearRlMap(): void {
  if (process.env['NODE_ENV'] !== 'test') _TEST_ONLY_DISABLED();
  _probeRlWindows.clear();
}
