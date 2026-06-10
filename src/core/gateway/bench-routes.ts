/**
 * @file bench-routes.ts
 * @description HTTP routes for the benchmark subsystem.
 *
 * Endpoints:
 *   GET  /v1/admin/bench          — C5: list recent bench run summaries
 *   GET  /v1/admin/bench/results  — C6: list BenchResult rows with optional filter
 *   POST /v1/admin/bench/run      — C7: enqueue a new async bench run
 *
 * Auth: timing-safe Bearer token (same pattern as skills/routes.ts).
 * Body: capped at 256 KB.
 * Error shape: { error: { message: string; code: number } }
 */

import { timingSafeEqual, randomUUID } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import type { SkillCondition } from '../shared/wave10-types.js';
import { BenchStore } from '../eval/bench-store.js';
import { BenchRunner } from '../eval/bench-runner.js';

const log = createLogger('gateway:bench-routes');
const MAX_BODY = 256 * 1024;

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface BenchRoutesDeps {
  /** BenchStore instance. Required. */
  benchStore: BenchStore;
  /** Optional brain for live runs. If absent, runs are synthetic (all fail). */
  brain?: { call(opts: { messages: Array<{ role: string; content: string }>; model: string }): Promise<{ content: string }> };
}

// ---------------------------------------------------------------------------
// Auth helpers (self-contained)
// ---------------------------------------------------------------------------

function getTokenBuf(): Buffer | null {
  const t = process.env['GATEWAY_TOKEN'];
  return t && t.length > 0 ? Buffer.from(t, 'utf8') : null;
}

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

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message, code: status } });
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseQs(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx < 0) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(url.slice(idx + 1)).entries()) {
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// In-memory queue for async runs (keeps gateway non-blocking)
// ---------------------------------------------------------------------------

type RunStatus = 'queued' | 'running' | 'done' | 'error';

const runQueue = new Map<string, RunStatus>();

// ---------------------------------------------------------------------------
// Sliding-window rate limiter for POST /v1/admin/bench/run (FIX 5)
// 5 requests per 60-second window per token (or per-IP if no token).
// Max queue depth: 10 queued/running entries before 503.
// ---------------------------------------------------------------------------

const BENCH_RL_WINDOW_MS = 60_000;
const BENCH_RL_MAX = 5;
const BENCH_QUEUE_MAX = 10;
const _benchRlWindows = new Map<string, number[]>();

function checkBenchRateLimit(req: IncomingMessage, tb: Buffer | null): { allowed: boolean; retryAfterSec: number } {
  const bearer = (() => {
    const h = req.headers['authorization'] ?? '';
    if (typeof h !== 'string') return '';
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    return m ? (m[1] ?? '') : '';
  })();
  const key = bearer.length > 0
    ? `token:${bearer}`
    : `ip:${(req.socket.remoteAddress ?? 'unknown')}`;
  // suppress unused tb warning — tb is already checked by isAuthorised before this call
  void tb;

  const now = Date.now();
  const timestamps = (_benchRlWindows.get(key) ?? []).filter((t) => now - t < BENCH_RL_WINDOW_MS);

  if (timestamps.length >= BENCH_RL_MAX) {
    const oldest = timestamps[0]!;
    const retryAfterSec = Math.ceil((BENCH_RL_WINDOW_MS - (now - oldest)) / 1000);
    log.warn({ key, count: timestamps.length }, 'bench run rate limit exceeded');
    return { allowed: false, retryAfterSec };
  }

  timestamps.push(now);
  _benchRlWindows.set(key, timestamps);
  return { allowed: true, retryAfterSec: 0 };
}

function getActiveQueueDepth(): number {
  let count = 0;
  for (const status of runQueue.values()) {
    if (status === 'queued' || status === 'running') count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** GET /v1/admin/bench — list recent runs */
function handleListRuns(res: ServerResponse, deps: BenchRoutesDeps): void {
  try {
    const runs = deps.benchStore.listReports(50);
    sendJson(res, 200, { runs });
  } catch (err) {
    log.error({ err: String(err) }, 'bench-routes: listReports failed');
    sendError(res, 500, 'Internal server error');
  }
}

/** GET /v1/admin/bench/results — list results with filter */
function handleListResults(req: IncomingMessage, res: ServerResponse, deps: BenchRoutesDeps): void {
  const qs = parseQs(req.url ?? '');
  const runId     = qs['runId'];
  const model     = qs['model'];
  const condition = qs['condition'] as SkillCondition | undefined;
  const limit     = Math.min(parseInt(qs['limit'] ?? '100', 10) || 100, 500);

  const VALID_CONDITIONS: Set<string> = new Set(['no_skills', 'skills_on', 'skills_optimized']);
  if (condition && !VALID_CONDITIONS.has(condition)) {
    sendError(res, 400, `Invalid condition: ${condition}`);
    return;
  }

  try {
    const results = deps.benchStore.listResults({ runId, model, condition, limit });
    const report  = runId ? (deps.benchStore.getReport(runId) ?? undefined) : undefined;
    sendJson(res, 200, { data: results, ...(report ? { report } : {}) });
  } catch (err) {
    log.error({ err: String(err) }, 'bench-routes: listResults failed');
    sendError(res, 500, 'Internal server error');
  }
}

/** POST /v1/admin/bench/run — enqueue an async bench run */
async function handleRunBench(req: IncomingMessage, res: ServerResponse, deps: BenchRoutesDeps, tb: Buffer | null): Promise<void> {
  // FIX 5: rate limit — 5 req/min per token (or per-IP)
  const rl = checkBenchRateLimit(req, tb);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfterSec));
    sendError(res, 429, 'Too many bench run requests — please retry later');
    return;
  }

  // FIX 5: queue depth check — reject if >= 10 queued/running
  const queueDepth = getActiveQueueDepth();
  if (queueDepth >= BENCH_QUEUE_MAX) {
    sendError(res, 503, `Bench queue full (${queueDepth} active runs) — try again later`);
    return;
  }

  let body: { models?: string[]; tasks?: string[]; conditions?: SkillCondition[]; seeds?: number };
  try {
    const raw = await readBody(req);
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    sendError(res, 400, 'Invalid or oversized request body');
    return;
  }

  const models     = Array.isArray(body.models)     ? body.models     : ['default'];
  const tasks      = Array.isArray(body.tasks)      ? body.tasks      : [];
  const conditions = Array.isArray(body.conditions) ? body.conditions : undefined;
  const seeds      = typeof body.seeds === 'number'  ? body.seeds      : 1;

  if (models.some(m => typeof m !== 'string' || m.length === 0)) {
    sendError(res, 400, 'models must be an array of non-empty strings');
    return;
  }

  const runId = randomUUID();
  runQueue.set(runId, 'queued');
  sendJson(res, 202, { runId, status: 'queued' });

  // Run asynchronously — do not await here
  void (async () => {
    runQueue.set(runId, 'running');
    try {
      const runner = new BenchRunner(deps.benchStore);
      await runner.run({
        models,
        taskIds:    tasks,
        conditions,
        seeds,
        brain: deps.brain,
        store: deps.benchStore,
      });
      runQueue.set(runId, 'done');
      log.info({ runId }, 'bench-routes: async run completed');
    } catch (err) {
      runQueue.set(runId, 'error');
      log.error({ err: String(err), runId }, 'bench-routes: async run failed');
    }
  })();
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register bench routes on the HTTP server.
 *
 * @param server   - Raw node:http Server.
 * @param deps     - BenchRoutesDeps with benchStore (and optional brain).
 * @param tokenBuf - Pre-computed GATEWAY_TOKEN buffer for timing-safe auth.
 */
export function registerBenchRoutes(server: HttpServer, deps: BenchRoutesDeps, tokenBuf?: Buffer | null): void {
  const tb = tokenBuf !== undefined ? tokenBuf : getTokenBuf();

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method   = req.method ?? '';
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';

    if (!pathname.startsWith('/v1/admin/bench')) return;
    if (!isAuthorised(req, tb)) { sendError(res, 401, 'Unauthorized'); return; }

    if (method === 'GET' && pathname === '/v1/admin/bench') {
      handleListRuns(res, deps);
      return;
    }

    if (method === 'GET' && pathname === '/v1/admin/bench/results') {
      handleListResults(req, res, deps);
      return;
    }

    if (method === 'POST' && pathname === '/v1/admin/bench/run') {
      handleRunBench(req, res, deps, tb).catch((err: unknown) => {
        log.error({ err: String(err) }, 'bench-routes: unhandled error in handleRunBench');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    sendError(res, 404, 'Not found');
  });

  log.info('Bench routes registered (GET /v1/admin/bench, GET /v1/admin/bench/results, POST /v1/admin/bench/run)');
}
