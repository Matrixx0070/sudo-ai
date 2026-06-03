/**
 * @file skills-hub-routes.ts
 * @description HTTP request handlers for SkillsHub REST endpoints.
 *
 * Endpoints:
 *   GET    /v1/skills/registry/search?q=<query>  — search remote registry
 *   POST   /v1/skills/registry/install           — install from registry
 *   POST   /v1/skills/registry/update            — check + apply updates
 *   GET    /v1/skills/installed                  — list installed skills
 *   DELETE /v1/skills/installed/:name            — remove installed skill
 *
 * Auth: GATEWAY_TOKEN bearer token (timing-safe).
 * Kill-switches: SUDO_SKILLS_HUB_DISABLE=1, SUDO_SKILLS_INSTALL_DISABLE=1
 */

import { timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import type { SkillRegistry } from './registry.js';
import type { SkillsHub as SkillsHubClass } from './skills-hub.js';

const log = createLogger('skills:hub-routes');

const MAX_BODY = 64 * 1024;

// ---------------------------------------------------------------------------
// Auth helpers (self-contained — same pattern as routes.ts)
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

function isAuthorised(req: IncomingMessage): boolean {
  const tokenBuf = getTokenBuf();
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

function sendError(res: ServerResponse, status: number, msg: string): void {
  sendJson(res, status, { error: { message: msg, code: status } });
}

async function readBody(req: IncomingMessage, maxBytes = MAX_BODY): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSkillsHubRoutes(
  server: HttpServer,
  hub: SkillsHubClass,
  registry: SkillRegistry | null = null,
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    // Only handle /v1/skills/registry and /v1/skills/installed paths
    if (!url.startsWith('/v1/skills/registry') && !url.startsWith('/v1/skills/installed')) {
      return;
    }

    // Auth check on all routes
    if (!isAuthorised(req)) {
      sendError(res, 401, 'Unauthorized');
      return;
    }

    void handleRequest(req, res, method, url, hub).catch((err: unknown) => {
      log.error({ err }, 'unhandled error in skills hub routes');
      if (!res.headersSent) sendError(res, 500, 'Internal server error');
    });
  });

  log.info('skills hub routes registered');
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: string,
  hub: SkillsHubClass,
): Promise<void> {
  const [pathname] = url.split('?');
  const searchParams = new URLSearchParams(url.includes('?') ? url.split('?')[1] : '');

  // GET /v1/skills/registry/search?q=<query>
  if (method === 'GET' && pathname === '/v1/skills/registry/search') {
    const query = searchParams.get('q') ?? '';
    const page = parseInt(searchParams.get('page') ?? '1', 10) || 1;
    const limit = parseInt(searchParams.get('limit') ?? '20', 10) || 20;

    try {
      const result = await hub.search(query, page, limit);
      sendJson(res, 200, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, 'registry search failed');
      if (msg.includes('SUDO_SKILLS_HUB_DISABLE')) {
        sendError(res, 503, 'SkillsHub is disabled');
      } else if (msg.includes('timeout') || msg.includes('abort')) {
        sendError(res, 504, 'Registry search timed out');
      } else {
        sendError(res, 502, 'Registry unavailable');
      }
    }
    return;
  }

  // POST /v1/skills/registry/install
  if (method === 'POST' && pathname === '/v1/skills/registry/install') {
    let body: { name?: unknown; version?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as { name?: unknown; version?: unknown };
    } catch {
      sendError(res, 400, 'Invalid JSON body');
      return;
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      sendError(res, 400, 'Skill name is required');
      return;
    }

    const version = typeof body.version === 'string' ? body.version.trim() : undefined;

    try {
      const installed = await hub.install(name, version);
      sendJson(res, 200, { installed: true, skill: installed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err, name }, 'skill install failed');
      if (msg.includes('SUDO_SKILLS_HUB_DISABLE') || msg.includes('SUDO_SKILLS_INSTALL_DISABLE')) {
        sendError(res, 503, 'Skill installation is disabled');
      } else if (msg.includes('not found') || msg.includes('404')) {
        sendError(res, 404, 'Skill not found in registry');
      } else if (msg.includes('timeout') || msg.includes('abort')) {
        sendError(res, 504, 'Install timed out');
      } else {
        sendError(res, 500, msg);
      }
    }
    return;
  }

  // POST /v1/skills/registry/update
  if (method === 'POST' && pathname === '/v1/skills/registry/update') {
    let body: { name?: unknown } | undefined;
    try {
      const rawBody = await readBody(req);
      body = rawBody ? (JSON.parse(rawBody) as { name?: unknown }) : undefined;
    } catch {
      sendError(res, 400, 'Invalid JSON body');
      return;
    }

    const name = body && typeof body.name === 'string' ? body.name.trim() : undefined;

    try {
      const updates = await hub.update(name);
      sendJson(res, 200, { updates });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, 'skill update check failed');
      if (msg.includes('SUDO_SKILLS_HUB_DISABLE') || msg.includes('SUDO_SKILLS_INSTALL_DISABLE')) {
        sendError(res, 503, 'Skill updates are disabled');
      } else {
        sendError(res, 500, msg);
      }
    }
    return;
  }

  // GET /v1/skills/installed
  if (method === 'GET' && pathname === '/v1/skills/installed') {
    const source = searchParams.get('source') as 'bundled' | 'registry' | 'import' | 'workspace' | undefined;
    const skills = hub.list(source);
    sendJson(res, 200, { skills });
    return;
  }

  // DELETE /v1/skills/installed/:name
  const deleteMatch = /^\/v1\/skills\/installed\/([^/]+)$/.exec(pathname ?? '');
  if (method === 'DELETE' && deleteMatch) {
    const name = deleteMatch[1] ?? '';
    if (!name) {
      sendError(res, 400, 'Skill name is required');
      return;
    }

    try {
      const removed = hub.remove(name);
      if (removed) {
        sendJson(res, 200, { removed: true, name });
      } else {
        sendError(res, 404, 'Skill not found');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err, name }, 'skill remove failed');
      if (msg.includes('SUDO_SKILLS_INSTALL_DISABLE')) {
        sendError(res, 503, 'Skill removal is disabled');
      } else {
        sendError(res, 500, msg);
      }
    }
    return;
  }

  sendError(res, 404, 'Not found');
}
