/**
 * @file admin-sleep-routes.ts
 * @description Admin REST route for sleep-cycle DEGRADED state management.
 *
 * Route:
 *   POST /v1/admin/sleep/reset-degraded — clears the _degraded flag + audits
 *
 * Auth: timing-safe Bearer token check (helpers copied inline — no import from
 *   admin-routes.ts to avoid circular-dependency risk).
 * Errors: never leak internal details; return generic 500 message.
 */

import { authenticateHttp } from './auth.js';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';

const log = createLogger('gateway:admin-sleep-routes');

const MAX_BODY = 256 * 1024; // 256 KB body cap
const MIN_REASON_LEN = 10;

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface AdminSleepRoutesDeps {
  sleepCycle: {
    clearDegraded(): void;
    isDegraded(): boolean;
  };
  auditTrail: {
    recordTriple(entry: {
      mistake: string;
      learned: string;
      commitment: string;
      ttl_days: number;
    }): void;
  };
}

// Auth centralised in ./auth.ts (authenticateHttp): GATEWAY_TOKEN header bearer,
// loopback-dev when unset, fail-closed when proxied.

// ---------------------------------------------------------------------------
// Internal HTTP helpers (copied inline)
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
  sendJson(res, status, { ok: false, error: message });
}

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

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

async function handleResetDegraded(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminSleepRoutesDeps,
): Promise<void> {
  // Parse body for required reason field
  let body: unknown;
  try {
    const raw = await readBody(req);
    body = raw.length > 0 ? (JSON.parse(raw) as unknown) : {};
  } catch {
    sendError(res, 400, 'Invalid or oversized request body');
    return;
  }

  const parsed = body as Record<string, unknown>;
  const reason = parsed['reason'];

  if (typeof reason !== 'string' || reason.trim().length < MIN_REASON_LEN) {
    sendError(
      res,
      400,
      `reason must be a string of at least ${MIN_REASON_LEN} characters`,
    );
    return;
  }

  try {
    const wasDegraded = deps.sleepCycle.isDegraded();
    deps.sleepCycle.clearDegraded();

    deps.auditTrail.recordTriple({
      mistake: 'sleep-degraded-manual-reset',
      learned: reason.trim(),
      commitment: 'reset',
      ttl_days: 1,
    });

    sendJson(res, 200, { ok: true, data: { wasDegrade: wasDegraded, ts: Date.now() } });
    log.info({ wasDegraded, ts: Date.now() }, 'Admin: sleep degraded flag reset');
  } catch (err: unknown) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Admin: reset-degraded handler failed',
    );
    sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Attach admin sleep management routes to the provided http.Server.
 *
 * @param server   - Existing http.Server (shared with the rest of the gateway).
 * @param deps     - sleepCycle and auditTrail dependencies.
 * @param tokenBuf - Pre-computed Buffer from the GATEWAY_TOKEN env var, or null.
 */
export function registerAdminSleepRoutes(
  server: HttpServer,
  deps: AdminSleepRoutesDeps,
  tokenBuf: Buffer | null,
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? '';
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';

    if (method === 'POST' && pathname === '/v1/admin/sleep/reset-degraded') {
      if (!authenticateHttp(req, { secretOverride: tokenBuf }).ok) {
        sendError(res, 401, 'Unauthorized: invalid or missing bearer token');
        return;
      }
      handleResetDegraded(req, res, deps).catch((err: unknown) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'Admin: unhandled error in reset-degraded',
        );
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
    }
  });

  log.info('Admin sleep routes registered (POST /v1/admin/sleep/reset-degraded)');
}
