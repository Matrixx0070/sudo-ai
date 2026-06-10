/**
 * @file gateway/compare-routes.ts
 * @description GET /v1/admin/compare — side-by-side model comparison endpoint.
 *
 * Auth: timing-safe Bearer token (same pattern as admin-routes.ts).
 * Endpoint: GET /v1/admin/compare?a=<modelId>&b=<modelId>&prompt=<text>
 *
 * Both model calls are made concurrently via Promise.all.
 * Returns CompareResult with responses, latencies, costs, and complexity.
 *
 * Usage (registered in http-api.ts):
 *   registerCompareRoutes(server, { brain, complexityScorer });
 */

import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { estimateCost, estimateEnergy } from '../brain/costs.js';
import type { CompareResult, ComplexityResult } from '../shared/wave10-types.js';

const log = createLogger('gateway:compare-routes');

// ---------------------------------------------------------------------------
// Dependency interfaces (duck-typed)
// ---------------------------------------------------------------------------

/** Minimal interface required from Brain for model calls. */
export interface BrainLike {
  /**
   * Run inference on a specific model.
   * Returns the generated text and token usage.
   */
  runWithModel?(
    modelId: string,
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number },
  ): Promise<{ text: string; inputTokens?: number; outputTokens?: number }>;
}

/** Minimal interface required from ComplexityScorer. */
export interface ComplexityScorerLike {
  score(prompt: string, modelName?: string): ComplexityResult;
}

// ---------------------------------------------------------------------------
// Auth helpers
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
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message, code: status } });
}

// ---------------------------------------------------------------------------
// Sliding-window rate limiter for GET /v1/admin/compare
// 5 requests per 60-second window per bearer token (or per-IP if no token).
// ---------------------------------------------------------------------------

const COMPARE_RL_WINDOW_MS = 60_000;
const COMPARE_RL_MAX       = 5;
const _compareRlWindows    = new Map<string, number[]>();

function checkCompareRateLimit(req: IncomingMessage): { allowed: boolean; retryAfterSec: number } {
  const bearer = extractBearer(req);
  // Hash bearer token before using as Map key — prevents plaintext tokens in memory.
  const key = bearer.length > 0
    ? `token:${createHash('sha256').update(bearer).digest('hex')}`
    : `ip:${(req.socket.remoteAddress ?? 'unknown')}`;

  const now = Date.now();

  // Evict stale entries (all timestamps outside the window) to prevent unbounded Map growth.
  for (const [k, ts] of _compareRlWindows) {
    if (ts.every((t) => now - t >= COMPARE_RL_WINDOW_MS)) {
      _compareRlWindows.delete(k);
    }
  }

  const timestamps = (_compareRlWindows.get(key) ?? []).filter((t) => now - t < COMPARE_RL_WINDOW_MS);

  if (timestamps.length >= COMPARE_RL_MAX) {
    const oldest = timestamps[0]!;
    const retryAfterSec = Math.ceil((COMPARE_RL_WINDOW_MS - (now - oldest)) / 1000);
    log.warn({ key, count: timestamps.length }, 'compare rate limit exceeded');
    return { allowed: false, retryAfterSec };
  }

  timestamps.push(now);
  _compareRlWindows.set(key, timestamps);
  return { allowed: true, retryAfterSec: 0 };
}

// ---------------------------------------------------------------------------
// Stub complexity result (used when ComplexityScorer not available)
// ---------------------------------------------------------------------------

function stubComplexity(prompt: string): ComplexityResult {
  const score = Math.min(1, prompt.length / 4000);
  let tier: ComplexityResult['tier'] = 'simple';
  let suggested_max_tokens = 2048;
  if (score >= 0.75) { tier = 'very_complex'; suggested_max_tokens = 16384; }
  else if (score >= 0.5) { tier = 'complex'; suggested_max_tokens = 8192; }
  else if (score >= 0.25) { tier = 'moderate'; suggested_max_tokens = 4096; }
  return { score, tier, signals: ['prompt_length'], suggested_max_tokens, thinking_model: false };
}

// ---------------------------------------------------------------------------
// Single model call
// ---------------------------------------------------------------------------

async function callModel(
  brain: BrainLike,
  modelId: string,
  prompt: string,
): Promise<{ text: string; latencyMs: number; inputTokens: number; outputTokens: number }> {
  const start = Date.now();

  if (typeof brain.runWithModel !== 'function') {
    // Brain does not support per-model calls — return a placeholder
    log.warn({ modelId }, 'Brain.runWithModel not available — returning stub response');
    return {
      text: `[Compare stub: ${modelId} does not support direct invocation]`,
      latencyMs: Date.now() - start,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  const result = await brain.runWithModel(modelId, prompt);
  return {
    text: result.text,
    latencyMs: Date.now() - start,
    inputTokens: result.inputTokens ?? 0,
    outputTokens: result.outputTokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleCompare(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { brain: BrainLike; complexityScorer: ComplexityScorerLike },
): Promise<void> {
  const tokenBuf = getTokenBuf();
  if (!isAuthorised(req, tokenBuf)) {
    sendError(res, 401, 'Unauthorized: invalid or missing bearer token');
    return;
  }

  const url    = req.url ?? '/';
  const search = url.includes('?') ? url.split('?').slice(1).join('?') : '';
  const params = new URLSearchParams(search);

  const modelA = params.get('a');
  const modelB = params.get('b');
  const prompt = params.get('prompt');

  if (!modelA || !modelB || !prompt) {
    sendError(res, 400, "Missing required query parameters: 'a', 'b', and 'prompt' are all required");
    return;
  }

  if (prompt.length > 4096) {
    sendError(res, 400, 'prompt must be <= 4096 characters');
    return;
  }

  log.info({ modelA, modelB, promptLen: prompt.length }, 'GET /v1/admin/compare starting');

  // Run both models concurrently
  const [resultA, resultB] = await Promise.all([
    callModel(deps.brain, modelA, prompt),
    callModel(deps.brain, modelB, prompt),
  ]);

  // Complexity scoring
  const complexityA = deps.complexityScorer.score(prompt, modelA);
  const complexityB = deps.complexityScorer.score(prompt, modelB);

  // Cost + energy estimation
  const costAusd = estimateCost(modelA, resultA.inputTokens, resultA.outputTokens);
  const costBusd = estimateCost(modelB, resultB.inputTokens, resultB.outputTokens);

  const energyA = estimateEnergy(modelA, resultA.inputTokens, resultA.outputTokens);
  const energyB = estimateEnergy(modelB, resultB.inputTokens, resultB.outputTokens);

  const compareResult: CompareResult & { energyA: typeof energyA; energyB: typeof energyB } = {
    runId: randomUUID(),
    modelA,
    modelB,
    prompt,
    responseA: resultA.text,
    responseB: resultB.text,
    latencyAms: resultA.latencyMs,
    latencyBms: resultB.latencyMs,
    costAusd,
    costBusd,
    complexityA,
    complexityB,
    timestamp: new Date().toISOString(),
    energyA,
    energyB,
  };

  sendJson(res, 200, compareResult);
  log.info(
    {
      runId: compareResult.runId,
      modelA,
      modelB,
      latencyAms: resultA.latencyMs,
      latencyBms: resultB.latencyMs,
      costAusd,
      costBusd,
    },
    'GET /v1/admin/compare complete',
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register GET /v1/admin/compare on the provided HTTP server.
 *
 * Called in http-api.ts (same pattern as registerFederationRoutes).
 * '/v1/admin' is already in the fallthrough list, so no extra entry needed.
 *
 * @param server  - Existing http.Server (shared with other routes).
 * @param deps    - { brain: BrainLike; complexityScorer: ComplexityScorerLike }
 */
export function registerCompareRoutes(
  server: HttpServer,
  deps: { brain: BrainLike; complexityScorer: ComplexityScorerLike },
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method   = req.method ?? '';
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';

    if (method !== 'GET' || pathname !== '/v1/admin/compare') return;

    // Rate limit check — before auth (fail fast, no token consumption on limit hit)
    const rl = checkCompareRateLimit(req);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      sendError(res, 429, 'Too many compare requests — please retry after the Retry-After interval.');
      return;
    }

    handleCompare(req, res, deps).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'GET /v1/admin/compare unhandled error');
      if (!res.headersSent) sendError(res, 500, 'Internal server error');
    });
  });

  log.info('Compare routes registered (GET /v1/admin/compare)');
}
