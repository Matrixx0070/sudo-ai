/**
 * @file gateway/federation-error-routes.ts
 * @description Federation error route registration.
 *
 * Federation Error Protocol.
 */

import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import type { FederationErrorRoutesDeps } from './federation-error-types.js';
import {
  handleErrorReport,
  handleFixNotify,
  handleTokenContribute,
  handleErrorReports,
  handleTokenPool,
} from './federation-error-handlers.js';
import { sendError } from './federation-error-helpers.js';
import { FEDERATION_KNOWN_PATHS } from './federation-paths.js';

const log = createLogger('gateway:federation-error-routes');

export function registerFederationErrorRoutes(
  server: HttpServer,
  deps: FederationErrorRoutesDeps,
  adminTokenBuf: Buffer | null,
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? '';
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';

    if (!pathname.startsWith('/v1/federation/')) return;

    if (method === 'POST' && pathname === '/v1/federation/error-report') {
      handleErrorReport(req, res, deps).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'unhandled error in error-report');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    if (method === 'POST' && pathname === '/v1/federation/fix-notify') {
      handleFixNotify(req, res, adminTokenBuf, deps).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'unhandled error in fix-notify');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    if (method === 'POST' && pathname === '/v1/federation/token-contribute') {
      handleTokenContribute(req, res, deps).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'unhandled error in token-contribute');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    if (method === 'GET' && pathname === '/v1/federation/error-reports') {
      handleErrorReports(req, res, adminTokenBuf, deps);
      return;
    }

    if (method === 'GET' && pathname === '/v1/federation/token-pool') {
      handleTokenPool(req, res, adminTokenBuf, deps);
      return;
    }

    // Unmatched /v1/federation/* path. If no federation router owns this path,
    // send 404; otherwise defer to the sibling router (federation-routes.ts) that
    // does. Guarded by res.headersSent/writableEnded so the first router to reach
    // here wins and any sibling no-ops — never a double-response.
    if (!FEDERATION_KNOWN_PATHS.has(pathname) && !res.headersSent && !res.writableEnded) {
      sendError(res, 404, 'Not found');
    }
    return;
  });

  log.info(
    'Federation error routes registered (POST /v1/federation/error-report, POST /v1/federation/fix-notify, POST /v1/federation/token-contribute, GET /v1/federation/error-reports, GET /v1/federation/token-pool)',
  );
}
