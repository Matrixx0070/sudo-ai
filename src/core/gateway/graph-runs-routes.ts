/**
 * @file gateway/graph-runs-routes.ts
 * @description Read-only admin surface for AL4.2 graph runs — the Telemetry
 * per-run spend data (AL4.5) plus the AL4.4 approval inbox:
 *
 *   GET /v1/admin/graph-runs            → { runs }    (status + budget spent)
 *   GET /v1/admin/graph-runs/approvals  → { pending } (parked gates awaiting a decision)
 *
 * Self-contained listener modeled on bench-routes.ts: prefix guard, timing-safe
 * Bearer auth, JSON errors. Paths start with /v1/admin so the server.ts
 * route-owner allowlist already admits them. Deps are duck-typed to the
 * GraphRunStore read surface — the gateway never constructs orchestration state.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';

const log = createLogger('gateway:graph-runs-routes');

export interface GraphRunsRoutesDeps {
  /** GraphRunStore read surface (duck-typed). */
  store: {
    listRuns(limit?: number): unknown[];
    listPendingApprovals(): unknown[];
  };
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message, code: status } });
}

export function registerGraphRunsRoutes(
  server: HttpServer,
  deps: GraphRunsRoutesDeps,
  tokenBuf: Buffer | null,
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    const pathname = url.split('?')[0] ?? '';
    if (!pathname.startsWith('/v1/admin/graph-runs')) return;
    if (res.writableEnded) return;

    if (!isAuthorised(req, tokenBuf)) {
      sendError(res, 401, 'Unauthorized');
      return;
    }
    if (req.method !== 'GET') {
      sendError(res, 405, 'Method not allowed');
      return;
    }

    try {
      if (pathname === '/v1/admin/graph-runs') {
        const rawLimit = Number(new URLSearchParams(url.split('?')[1] ?? '').get('limit'));
        const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
        sendJson(res, 200, { runs: deps.store.listRuns(limit) });
        return;
      }
      if (pathname === '/v1/admin/graph-runs/approvals') {
        sendJson(res, 200, { pending: deps.store.listPendingApprovals() });
        return;
      }
      sendError(res, 404, 'Not found');
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'graph-runs route failed');
      sendError(res, 500, 'Internal error');
    }
  });
  log.info('Graph-runs admin routes registered (/v1/admin/graph-runs*)');
}
