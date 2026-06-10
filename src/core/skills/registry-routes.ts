/**
 * @file registry-routes.ts
 * @description Public agentskills.io registry endpoints — no auth required.
 *
 * Exposes bundled skills to the ecosystem.
 *
 * Endpoints (3 total — all PUBLIC, CORS wildcard):
 *   GET     /v1/registry/skills           — list bundled skills (paginated, 60/min/IP)
 *   GET     /v1/registry/skills/:id       — single skill detail (60/min/IP)
 *   GET     /v1/registry/skills/:id/raw   — raw SKILL.md content (20/min/IP, ETag/304)
 *   OPTIONS /v1/registry/skills*          — CORS preflight → 204
 *
 * Trust-tier gate: only `trust_tier === 'bundled'` is served. All others → 404.
 *
 * Helpers (rate-limit, CORS, projection, YAML emitter) are in registry-route-types.ts.
 */

import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { SkillRegistry, SkillRegistryError } from './registry.js';
import {
  MAX_RAW_BYTES,
  setCors,
  sendJson,
  sendError,
  checkListRateLimit,
  checkRawRateLimit,
  isBundled,
  toPublicEntry,
  findBundledByFrontmatterId,
  emitFrontmatterYaml,
} from './registry-route-types.js';

// Re-export test seam so QE can import from here (spec T8 isolation requirement)
export { _resetRegistryRateLimits } from './registry-route-types.js';

const log = createLogger('skills:registry-routes');

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: string,
  registry: SkillRegistry,
): Promise<void> {
  const [pathname] = url.split('?');
  const searchParams = new URLSearchParams(url.includes('?') ? url.split('?')[1] : '');

  // OPTIONS preflight — CORS + 204
  if (method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204, { 'Content-Length': '0' });
    res.end();
    return;
  }

  // Only handle GET
  if (method !== 'GET') {
    setCors(res);
    sendError(res, 405, 'Method Not Allowed');
    return;
  }

  // GET /v1/registry/skills (exact)
  if (pathname === '/v1/registry/skills') {
    const rl = checkListRateLimit(req);
    if (!rl.allowed) {
      setCors(res);
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      sendError(res, 429, 'Too many requests — please retry later');
      return;
    }

    const limit  = Math.min(200, Math.max(1, parseInt(searchParams.get('limit')  ?? '50', 10) || 50));
    const offset = Math.max(0,               parseInt(searchParams.get('offset') ?? '0',  10) || 0);

    // list() already excludes archived; it orders by created_at DESC across ALL
    // trust tiers, so a SQL LIMIT here would drop bundled skills that sit below
    // newer non-bundled rows. Fetch the full set (bundled skills are far fewer —
    // same bound used by installed()/findBundledByFrontmatterId), filter to
    // bundled to get the true total, then paginate on the bundled subset.
    const all     = registry.list(1000, 0);
    const bundled = all.filter(isBundled);
    const page    = bundled.slice(offset, offset + limit);

    setCors(res);
    sendJson(res, 200, { data: page.map(toPublicEntry), total: bundled.length, limit, offset });
    return;
  }

  // Routes with :id — parse /:id and optional /suffix
  const idMatch = /^\/v1\/registry\/skills\/([^/]+)(\/.*)?$/.exec(pathname ?? '');
  if (!idMatch) {
    setCors(res);
    sendError(res, 404, 'Not found');
    return;
  }

  const frontmatterId = decodeURIComponent(idMatch[1] ?? '');
  const suffix        = idMatch[2] ?? '';

  // GET /v1/registry/skills/:id (no trailing suffix)
  if (suffix === '') {
    const rl = checkListRateLimit(req);
    if (!rl.allowed) {
      setCors(res);
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      sendError(res, 429, 'Too many requests — please retry later');
      return;
    }

    const meta = findBundledByFrontmatterId(registry, frontmatterId);
    // Issue D: static message — do not echo frontmatterId (avoids information leak)
    if (!meta) { setCors(res); sendError(res, 404, 'Skill not found'); return; }

    setCors(res);
    sendJson(res, 200, toPublicEntry(meta));
    return;
  }

  // GET /v1/registry/skills/:id/raw
  if (suffix === '/raw') {
    const rl = checkRawRateLimit(req);
    if (!rl.allowed) {
      setCors(res);
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      sendError(res, 429, 'Too many requests — please retry later');
      return;
    }

    const meta = findBundledByFrontmatterId(registry, frontmatterId);
    // Issue D: static message — do not echo frontmatterId (avoids information leak)
    if (!meta) { setCors(res); sendError(res, 404, 'Skill not found'); return; }

    // Fetch full record by internal UUID (body_md)
    let full;
    try {
      full = registry.getSkillById(meta.id);
    } catch (err) {
      if (err instanceof SkillRegistryError && err.code === 'SKILL_INJECTION_BLOCKED') {
        setCors(res);
        sendError(res, 422, 'Skill content blocked by injection scanner');
        return;
      }
      throw err;
    }

    // Issue D: static message — do not echo frontmatterId (avoids information leak)
    if (!full) { setCors(res); sendError(res, 404, 'Skill not found'); return; }

    // Reconstruct raw SKILL.md = YAML frontmatter + body
    const rawContent = `${emitFrontmatterYaml(full.frontmatter)}\n${full.body_md}`;
    const rawBytes   = Buffer.byteLength(rawContent, 'utf8');

    if (rawBytes > MAX_RAW_BYTES) {
      setCors(res);
      sendError(res, 413, 'Skill content exceeds size limit');
      return;
    }

    // ETag caching (spec C3)
    const etag        = `"sha256:${full.sha256}"`;
    const ifNoneMatch = req.headers['if-none-match'];
    if (typeof ifNoneMatch === 'string' && ifNoneMatch === etag) {
      setCors(res);
      // Issue C: nosniff on 304 as well for consistency
      res.writeHead(304, { ETag: etag, 'X-Content-Type-Options': 'nosniff' });
      res.end();
      return;
    }

    setCors(res);
    res.writeHead(200, {
      'Content-Type':            'text/markdown; charset=utf-8',
      'Content-Length':          rawBytes,
      'ETag':                    etag,
      'Cache-Control':           'public, max-age=300',
      'X-Content-Type-Options':  'nosniff',  // Issue C
    });
    res.end(rawContent);
    return;
  }

  // Unknown suffix
  setCors(res);
  sendError(res, 404, 'Not found');
}

// ---------------------------------------------------------------------------
// Route registration (spec E1)
// ---------------------------------------------------------------------------

export function registerRegistryRoutes(
  server: HttpServer,
  registry: SkillRegistry,
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url    = req.url    ?? '';
    const method = req.method ?? 'GET';

    // Only handle /v1/registry/skills — fall through for all other paths
    // Issue B: tighten guard so /v1/registry/skillsfoo does not match
    if (
      url !== '/v1/registry/skills' &&
      !url.startsWith('/v1/registry/skills/') &&
      !url.startsWith('/v1/registry/skills?')
    ) return;

    void handleRequest(req, res, method, url, registry).catch((err: unknown) => {
      log.error({ err }, 'unhandled error in registry route');
      if (!res.headersSent) { setCors(res); sendError(res, 500, 'Internal server error'); }
    });
  });

  log.info('public skill registry routes registered (/v1/registry/skills)');
}
