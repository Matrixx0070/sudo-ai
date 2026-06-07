/**
 * @file gateway/savings-routes.ts
 * @description GET /v1/savings — cost + energy savings summary endpoint.
 *
 * Wave 10 — Builder 3 (Config + Ops + UX)
 *
 * Auth: timing-safe Bearer token (same pattern as admin-routes.ts).
 * Endpoint: GET /v1/savings?period=session|day|week|month|all
 *
 * Returns:
 *   { rows: SavingsRow[]; totalCostUsd: number; totalWh: number; totalFlops: number }
 *
 * CostTracker is in-memory and session-keyed (no model breakdown yet).
 * This handler aggregates available data and supplements with energy estimates.
 * When CostTracker does not have per-model data, returns aggregate in a single row
 * attributed to provider 'aggregate'.
 *
 * Usage (Builder 2 registers this in http-api.ts):
 *   registerSavingsRoutes(server, { costTracker });
 */

import { timingSafeEqual, randomUUID } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { estimateEnergy } from '../brain/costs.js';
import type { SavingsRow } from '../shared/wave10-types.js';

const log = createLogger('gateway:savings-routes');

// ---------------------------------------------------------------------------
// Dependency interfaces (duck-typed)
// ---------------------------------------------------------------------------

/** Minimal interface required from CostTracker (or compatible object). */
export interface CostTrackerLike {
  /** Return aggregate totals across all sessions. */
  getTotalCost(): { calls: number; estimatedUsd: number };
  /** Optional per-model breakdown — if present, enables richer rows. */
  getModelBreakdown?(): Array<{
    model: string;
    provider: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    estimatedUsd: number;
  }>;
}

// ---------------------------------------------------------------------------
// Auth helpers (same pattern as admin-routes.ts)
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
// Period validation
// ---------------------------------------------------------------------------

type SavingsPeriod = 'session' | 'day' | 'week' | 'month' | 'all';
const VALID_PERIODS: SavingsPeriod[] = ['session', 'day', 'week', 'month', 'all'];

function parsePeriod(query: string | undefined): SavingsPeriod {
  if (query && VALID_PERIODS.includes(query as SavingsPeriod)) {
    return query as SavingsPeriod;
  }
  return 'all';
}

function periodStart(period: SavingsPeriod): string {
  const now = new Date();
  switch (period) {
    case 'session': return new Date(now.getTime() - 3600 * 1000).toISOString(); // 1h proxy
    case 'day':     return new Date(now.getTime() - 86400 * 1000).toISOString();
    case 'week':    return new Date(now.getTime() - 7 * 86400 * 1000).toISOString();
    case 'month':   return new Date(now.getTime() - 30 * 86400 * 1000).toISOString();
    case 'all':     return new Date(0).toISOString();
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function buildSavingsResponse(
  tracker: CostTrackerLike,
  period: SavingsPeriod,
): { rows: SavingsRow[]; totalCostUsd: number; totalWh: number; totalFlops: number } {
  const pStart = periodStart(period);

  // Use per-model breakdown if available
  if (typeof tracker.getModelBreakdown === 'function') {
    const breakdown = tracker.getModelBreakdown();
    const rows: SavingsRow[] = breakdown.map((entry) => {
      const energy = estimateEnergy(
        `${entry.provider}/${entry.model}`,
        entry.inputTokens,
        entry.outputTokens,
      );
      const rate = entry.estimatedUsd > 0 && entry.inputTokens + entry.outputTokens > 0
        ? {
            inputCostPerM: (entry.estimatedUsd / (entry.inputTokens / 1_000_000 + entry.outputTokens / 1_000_000)) / 2,
            outputCostPerM: (entry.estimatedUsd / (entry.inputTokens / 1_000_000 + entry.outputTokens / 1_000_000)) / 2,
          }
        : { inputCostPerM: 0, outputCostPerM: 0 };

      return {
        provider: entry.provider,
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        costUsd: entry.estimatedUsd,
        inputCostPerM: rate.inputCostPerM,
        outputCostPerM: rate.outputCostPerM,
        energy,
        period,
        periodStart: pStart,
      };
    });

    const totalCostUsd = rows.reduce((s, r) => s + r.costUsd, 0);
    const totalWh = rows.reduce((s, r) => s + r.energy.wh, 0);
    const totalFlops = rows.reduce((s, r) => s + r.energy.flops, 0);
    return { rows, totalCostUsd, totalWh, totalFlops };
  }

  // Fallback: aggregate-only row
  const total = tracker.getTotalCost();
  const avgModel = 'aggregate';
  const avgProvider = 'aggregate';
  // Split the total cost evenly across input/output before reconstructing
  // tokens, so the reported token counts re-price back to total.estimatedUsd
  // (rather than each direction independently accounting for the full cost).
  const inputCostUsd = total.estimatedUsd / 2;
  const outputCostUsd = total.estimatedUsd / 2;
  const estInputTokens = Math.round(inputCostUsd * 1_000_000 / 5); // assume $5/M input
  const estOutputTokens = Math.round(outputCostUsd * 1_000_000 / 20); // assume $20/M output
  const energy = estimateEnergy(avgModel, estInputTokens, estOutputTokens);

  const row: SavingsRow = {
    provider: avgProvider,
    model: avgModel,
    inputTokens: estInputTokens,
    outputTokens: estOutputTokens,
    costUsd: total.estimatedUsd,
    inputCostPerM: 5.0,
    outputCostPerM: 20.0,
    energy,
    period,
    periodStart: pStart,
  };

  return {
    rows: total.estimatedUsd > 0 ? [row] : [],
    totalCostUsd: total.estimatedUsd,
    totalWh: energy.wh,
    totalFlops: energy.flops,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register GET /v1/savings on the provided HTTP server.
 *
 * Builder 2 calls this in http-api.ts (same pattern as registerFederationRoutes).
 * Also add '/v1/savings' to the http-api.ts fallthrough list.
 *
 * @param server  - Existing http.Server (shared with other routes).
 * @param deps    - { costTracker: CostTrackerLike }
 */
export function registerSavingsRoutes(
  server: HttpServer,
  deps: { costTracker: CostTrackerLike },
): void {
  const tokenBuf = getTokenBuf();

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method   = req.method ?? '';
    const url      = req.url ?? '/';
    const pathname = url.split('?')[0] ?? '/';
    const search   = url.includes('?') ? url.split('?').slice(1).join('?') : '';

    if (method !== 'GET' || pathname !== '/v1/savings') return;

    if (!isAuthorised(req, tokenBuf)) {
      sendError(res, 401, 'Unauthorized: invalid or missing bearer token');
      return;
    }

    const params = new URLSearchParams(search);
    const period = parsePeriod(params.get('period') ?? undefined);

    try {
      const body = buildSavingsResponse(deps.costTracker, period);
      sendJson(res, 200, body);
      log.info({ period, rows: body.rows.length, totalCostUsd: body.totalCostUsd }, 'GET /v1/savings');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'GET /v1/savings failed');
      sendError(res, 500, 'Internal server error');
    }
  });

  log.info('Savings routes registered (GET /v1/savings)');
}

/** Unique run ID for savings requests (used in tests). */
export function newSavingsRunId(): string {
  return randomUUID();
}
