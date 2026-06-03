/**
 * profile-routes.ts — REST API endpoints for Profile management.
 *
 * Routes:
 *   GET  /v1/admin/profiles              — list all profiles
 *   POST /v1/admin/profiles              — create profile
 *   GET  /v1/admin/profiles/:name        — get profile details
 *   DELETE /v1/admin/profiles/:name      — delete profile
 *   POST /v1/admin/profiles/:name/activate — set as active profile
 *
 * All routes Bearer-gated (GATEWAY_TOKEN).
 * Kill-switch: SUDO_PROFILES_DISABLE=1 returns 503.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { profileManager } from './profile-manager.js';
import type { ProfileCreateOptions } from './profile-types.js';
import { PROFILES_KILL_SWITCH } from './profile-types.js';

const log = createLogger('profile-routes');

const MAX_BODY = 256 * 1024; // 256 KB body cap

// ---------------------------------------------------------------------------
// Auth helper (timing-safe, mirrors http-api.ts logic)
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
  sendJson(res, status, { ok: false, error: message });
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

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /v1/admin/profiles — list all profiles
 */
function handleListProfiles(res: ServerResponse): void {
  if (process.env[PROFILES_KILL_SWITCH] === '1') {
    sendError(res, 503, 'Profiles disabled (SUDO_PROFILES_DISABLE=1)');
    return;
  }

  try {
    const profiles = profileManager.listProfiles();
    sendJson(res, 200, { ok: true, data: { profiles, count: profiles.length } });
    log.info({ count: profiles.length }, 'Profiles listed');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to list profiles');
    sendError(res, 500, 'Internal server error');
  }
}

/**
 * POST /v1/admin/profiles — create profile
 * Body: { name, displayName?, env?, soulMd?, cloneFrom? }
 */
async function handleCreateProfile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (process.env[PROFILES_KILL_SWITCH] === '1') {
    sendError(res, 503, 'Profiles disabled (SUDO_PROFILES_DISABLE=1)');
    return;
  }

  let bodyText: string;
  try {
    bodyText = await readBody(req);
  } catch (err: unknown) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to read POST body');
    sendError(res, 400, 'Invalid request body');
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  // Validate required fields
  const name = parsed['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    sendError(res, 400, 'name is required and must be a non-empty string');
    return;
  }

  // Build create options
  const options: ProfileCreateOptions = {
    name: name.trim(),
  };

  if (typeof parsed['displayName'] === 'string' && parsed['displayName'].trim().length > 0) {
    options.displayName = parsed['displayName'].trim();
  }

  if (parsed['env'] !== undefined) {
    if (typeof parsed['env'] !== 'object' || parsed['env'] === null) {
      sendError(res, 400, 'env must be an object');
      return;
    }
    // Validate env values are strings
    const envObj = parsed['env'] as Record<string, unknown>;
    options.env = {};
    for (const [key, value] of Object.entries(envObj)) {
      if (typeof value !== 'string') {
        sendError(res, 400, `env.${key} must be a string`);
        return;
      }
      options.env[key] = value;
    }
  }

  if (typeof parsed['soulMd'] === 'string') {
    options.soulMd = parsed['soulMd'];
  }

  if (parsed['skills'] !== undefined) {
    if (!Array.isArray(parsed['skills'])) {
      sendError(res, 400, 'skills must be an array');
      return;
    }
    options.skills = parsed['skills'] as string[];
  }

  if (typeof parsed['cloneFrom'] === 'string' && parsed['cloneFrom'].trim().length > 0) {
    options.cloneFrom = parsed['cloneFrom'].trim();
  }

  try {
    let profile: ReturnType<typeof profileManager.createProfile>;

    if (options.cloneFrom) {
      profile = profileManager.cloneProfile(options.cloneFrom, options.name, options.displayName);
    } else {
      profile = profileManager.createProfile(options);
    }

    sendJson(res, 201, { ok: true, data: profile });
    log.info({ name: profile.name, clonedFrom: options.cloneFrom }, 'Profile created');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already exists')) {
      sendError(res, 409, msg);
    } else if (msg.includes('does not exist')) {
      sendError(res, 400, msg);
    } else {
      log.error({ err: msg, name: options.name }, 'Failed to create profile');
      sendError(res, 500, 'Internal server error');
    }
  }
}

/**
 * GET /v1/admin/profiles/:name — get profile details
 */
function handleGetProfile(res: ServerResponse, name: string): void {
  if (process.env[PROFILES_KILL_SWITCH] === '1') {
    sendError(res, 503, 'Profiles disabled (SUDO_PROFILES_DISABLE=1)');
    return;
  }

  try {
    const profile = profileManager.getProfile(name);
    if (!profile) {
      sendError(res, 404, 'Profile not found');
      return;
    }
    sendJson(res, 200, { ok: true, data: profile });
    log.info({ name }, 'Profile retrieved');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err), name }, 'Failed to get profile');
    sendError(res, 500, 'Internal server error');
  }
}

/**
 * DELETE /v1/admin/profiles/:name — delete profile
 */
function handleDeleteProfile(res: ServerResponse, name: string): void {
  if (process.env[PROFILES_KILL_SWITCH] === '1') {
    sendError(res, 503, 'Profiles disabled (SUDO_PROFILES_DISABLE=1)');
    return;
  }

  try {
    const deleted = profileManager.deleteProfile(name);
    if (!deleted) {
      sendError(res, 404, 'Profile not found');
      return;
    }
    sendJson(res, 200, { ok: true, data: { name, deleted: true } });
    log.info({ name }, 'Profile deleted');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err), name }, 'Failed to delete profile');
    sendError(res, 500, 'Internal server error');
  }
}

/**
 * POST /v1/admin/profiles/:name/activate — set as active profile
 */
function handleActivateProfile(res: ServerResponse, name: string): void {
  if (process.env[PROFILES_KILL_SWITCH] === '1') {
    sendError(res, 503, 'Profiles disabled (SUDO_PROFILES_DISABLE=1)');
    return;
  }

  try {
    const activated = profileManager.activateProfile(name);
    if (!activated) {
      sendError(res, 404, 'Profile not found');
      return;
    }
    sendJson(res, 200, { ok: true, data: { name, active: true } });
    log.info({ name }, 'Profile activated');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err), name }, 'Failed to activate profile');
    sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Register profile REST route handlers on the server's 'request' event.
 *
 * @param server - Existing http.Server.
 */
export function registerProfileRoutes(server: HttpServer): void {
  const tokenBuf = getTokenBuf();

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? '';
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';

    // Only handle /v1/admin/profiles*
    if (!pathname.startsWith('/v1/admin/profiles')) {
      return;
    }

    // Auth check
    if (!isAuthorised(req, tokenBuf)) {
      sendError(res, 401, 'Unauthorized: invalid or missing bearer token');
      return;
    }

    // GET /v1/admin/profiles (list)
    if (method === 'GET' && pathname === '/v1/admin/profiles') {
      handleListProfiles(res);
      return;
    }

    // POST /v1/admin/profiles (create)
    if (method === 'POST' && pathname === '/v1/admin/profiles') {
      handleCreateProfile(req, res).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Unhandled error in create profile');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // GET /v1/admin/profiles/:name
    const getMatch = /^\/v1\/admin\/profiles\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && getMatch) {
      const name = getMatch[1]!;
      handleGetProfile(res, name);
      return;
    }

    // DELETE /v1/admin/profiles/:name
    const deleteMatch = /^\/v1\/admin\/profiles\/([^/]+)$/.exec(pathname);
    if (method === 'DELETE' && deleteMatch) {
      const name = deleteMatch[1]!;
      handleDeleteProfile(res, name);
      return;
    }

    // POST /v1/admin/profiles/:name/activate
    const activateMatch = /^\/v1\/admin\/profiles\/([^/]+)\/activate$/.exec(pathname);
    if (method === 'POST' && activateMatch) {
      const name = activateMatch[1]!;
      handleActivateProfile(res, name);
      return;
    }

    // Unmatched profile path
    sendError(res, 404, 'Not found');
  });

  log.info('Profile routes registered (GET/POST /v1/admin/profiles, GET/DELETE /v1/admin/profiles/:name, POST /v1/admin/profiles/:name/activate)');
}
