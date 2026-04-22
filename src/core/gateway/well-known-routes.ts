/**
 * @file well-known-routes.ts
 * @description GET /.well-known/agentskills.json discovery endpoint.
 *
 * Public, no-auth, CORS wildcard discovery document per the agentskills.io spec.
 * Registered via registerWellKnownRoutes() called from cli.ts after registerRegistryRoutes().
 *
 * Response shape:
 *   { registry, spec_version, provider, total_skills, last_updated_iso }
 *
 * Features:
 *   - ETag (sha256 prefix) + 304 conditional GET
 *   - CORS wildcard (all responses)
 *   - Rate limit: 60 req/min/IP (reuses checkListRateLimit map)
 *   - Cache-Control: public, max-age=60
 *
 * Wave 10 Phase 1 — agentskills.io compliance.
 *
 * SECURITY: origin is pinned to SUDO_PUBLIC_BASE_URL env var; request headers
 * (Host, X-Forwarded-Proto) are NOT trusted to prevent Host Header Injection.
 * If SUDO_PUBLIC_BASE_URL is unset, falls back to http://localhost:18900.
 */

import { createHash } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { metrics } from '../health/metrics.js';
import { isBundled, checkListRateLimit } from '../skills/registry-route-types.js';
import type { SkillRegistry } from '../skills/registry.js';

const log = createLogger('well-known');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * Return the canonical public base URL for manifest construction.
 * Reads SUDO_PUBLIC_BASE_URL env var; strips trailing slash.
 * Falls back to http://localhost:18900 when unset.
 * Request headers (Host, X-Forwarded-Proto) are intentionally NOT read.
 */
function getPublicBaseUrl(): string {
  const raw = process.env['SUDO_PUBLIC_BASE_URL'] ?? 'http://localhost:18900';
  return raw.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Attach /.well-known/agentskills.json handler to an existing http.Server.
 *
 * MUST be registered BEFORE attachHttpApi() if server listeners are ordered
 * (in practice any order works because path-gating prevents double-response).
 *
 * @param server   - The shared http.Server instance (from startGateway / test).
 * @param registry - The live SkillRegistry (provides bundled skill count).
 */
export function registerWellKnownRoutes(
  server: HttpServer,
  registry: SkillRegistry,
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';

    // Path gate FIRST — only handle /.well-known/* paths.
    if (!pathname.startsWith('/.well-known/')) return;

    const method = req.method ?? 'GET';

    // Only /.well-known/agentskills.json is handled; all other /.well-known/* paths → 404.
    if (pathname !== '/.well-known/agentskills.json') {
      metrics.increment('wellknown_manifest_not_found_total');
      sendCors(res);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not found', code: 404 } }));
      return;
    }

    // CORS preflight
    if (method === 'OPTIONS') {
      sendCors(res);
      res.setHeader('Allow', 'GET, OPTIONS');
      res.writeHead(200);
      res.end();
      return;
    }

    if (method !== 'GET') {
      sendCors(res);
      res.writeHead(405, { Allow: 'GET, OPTIONS' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Rate limit — same 60/min/IP window as /v1/registry/skills list endpoint.
    const rl = checkListRateLimit(req);
    if (!rl.allowed) {
      sendCors(res);
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(rl.retryAfterSec),
      });
      res.end(JSON.stringify({ error: 'Too many requests', retryAfterSec: rl.retryAfterSec }));
      return;
    }

    // Build discovery document.
    try {
      const origin = getPublicBaseUrl();

      // Count bundled skills from live registry.
      const all = registry.list(1000, 0);
      const bundledCount = all.filter(isBundled).length;

      // last_updated_iso: most-recently-registered skill's created_at, else now.
      const latestCreatedAt = registry.list(1, 0)[0]?.created_at ?? new Date().toISOString();

      const body = {
        registry: `${origin}/v1/registry/skills`,
        spec_version: '1.0',
        provider: 'sudo-ai',
        total_skills: bundledCount,
        last_updated_iso: latestCreatedAt,
      };

      const json = JSON.stringify(body);

      // ETag: first 16 hex chars of sha256(json).
      const etag = `"${createHash('sha256').update(json).digest('hex').slice(0, 16)}"`;

      // CORS on every response (including 304).
      sendCors(res);

      // Conditional GET — 304 when ETag matches.
      const ifNoneMatch = req.headers['if-none-match'] as string | undefined;
      if (ifNoneMatch && ifNoneMatch === etag) {
        metrics.increment('wellknown_manifest_not_modified_total');
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.writeHead(304);
        res.end();
        return;
      }

      metrics.increment('wellknown_manifest_requests_total');
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
      });
      res.end(json);

      log.debug({ bundledCount, origin }, 'well-known served');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'well-known handler error');
      sendCors(res);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  log.info('well-known routes registered (GET /.well-known/agentskills.json)');
}
