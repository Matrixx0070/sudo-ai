/**
 * @file admin/security.handler.ts
 * @description Admin API handlers for security management.
 *
 * Routes registered:
 *   GET    /api/admin/security/tokens       — List API tokens (masked)
 *   POST   /api/admin/security/tokens       — Generate a new token
 *   DELETE /api/admin/security/tokens/:id   — Revoke a token
 *   GET    /api/admin/security/cors         — Get allowed CORS origins
 *   PUT    /api/admin/security/cors         — Update CORS origins
 *   GET    /api/admin/security/credentials  — Credential vault (masked env vars)
 *   GET    /api/admin/security/access-log   — Access log (placeholder)
 *
 * Token storage helpers live in security-helpers.ts.
 * Tokens are stored as SHA-256 hashes; the raw token is returned only once.
 */

import crypto from 'node:crypto';
import { adminRouter, sendJson, readJsonBody } from '../admin-router.js';
import { createLogger } from '../../shared/logger.js';
import {
  loadTokens,
  saveTokens,
  hashToken,
  generateTokenId,
  maskValue,
  getCorsOrigins,
  setCorsOrigins,
  SENSITIVE_KEYS,
  type StoredToken,
} from './security-helpers.js';

const log = createLogger('api:admin:security');

// ---------------------------------------------------------------------------
// GET /api/admin/security/tokens
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/security/tokens', async (_req, res) => {
  log.debug('GET /api/admin/security/tokens');

  const tokens = loadTokens();
  const masked = tokens.map((t) => ({
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    createdAt: t.createdAt,
    lastUsed: t.lastUsed,
  }));

  sendJson(res, 200, { tokens: masked, total: masked.length });
});

// ---------------------------------------------------------------------------
// POST /api/admin/security/tokens
// ---------------------------------------------------------------------------

adminRouter.post('/api/admin/security/tokens', async (req, res) => {
  log.debug('POST /api/admin/security/tokens');

  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(req)) as Record<string, unknown>;
  } catch (err) {
    log.warn({ err }, 'POST tokens: invalid JSON body');
    sendJson(res, 400, { error: { message: 'Invalid JSON body', code: 400 } });
    return;
  }

  const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
  if (!name) {
    sendJson(res, 400, { error: { message: '"name" field is required', code: 400 } });
    return;
  }
  if (name.length > 128) {
    sendJson(res, 400, { error: { message: '"name" must be 128 characters or fewer', code: 400 } });
    return;
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const newToken: StoredToken = {
    id: generateTokenId(),
    name,
    prefix: rawToken.slice(0, 8),
    hash: hashToken(rawToken),
    createdAt: new Date().toISOString(),
    lastUsed: null,
  };

  const tokens = loadTokens();
  tokens.push(newToken);

  try {
    saveTokens(tokens);
  } catch (err) {
    log.error({ err }, 'POST tokens: save failed');
    sendJson(res, 500, { error: { message: 'Failed to save token', code: 500 } });
    return;
  }

  log.info({ id: newToken.id, name }, 'API token created');

  // Return the raw token ONLY on creation — it cannot be recovered afterwards.
  sendJson(res, 201, {
    id: newToken.id,
    name: newToken.name,
    token: rawToken,
    prefix: newToken.prefix,
    createdAt: newToken.createdAt,
    warning: 'Store this token securely — it will not be shown again',
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/security/tokens/:id
// ---------------------------------------------------------------------------

adminRouter.delete('/api/admin/security/tokens/:id', async (_req, res, params) => {
  const id = params['id'];
  if (!id) {
    sendJson(res, 400, { error: { message: 'Token id param missing', code: 400 } });
    return;
  }

  log.debug({ id }, 'DELETE /api/admin/security/tokens/:id');

  const tokens = loadTokens();
  const idx = tokens.findIndex((t) => t.id === id);
  if (idx === -1) {
    sendJson(res, 404, { error: { message: 'Token not found', code: 404 } });
    return;
  }

  const [removed] = tokens.splice(idx, 1);

  try {
    saveTokens(tokens);
  } catch (err) {
    log.error({ err, id }, 'DELETE tokens: save failed');
    sendJson(res, 500, { error: { message: 'Failed to update token store', code: 500 } });
    return;
  }

  log.info({ id, name: removed!.name }, 'API token revoked');
  sendJson(res, 200, { success: true, id, name: removed!.name });
});

// ---------------------------------------------------------------------------
// GET /api/admin/security/cors
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/security/cors', async (_req, res) => {
  log.debug('GET /api/admin/security/cors');
  const origins = getCorsOrigins();
  sendJson(res, 200, { origins });
});

// ---------------------------------------------------------------------------
// PUT /api/admin/security/cors
// ---------------------------------------------------------------------------

adminRouter.put('/api/admin/security/cors', async (req, res) => {
  log.debug('PUT /api/admin/security/cors');

  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(req)) as Record<string, unknown>;
  } catch (err) {
    log.warn({ err }, 'PUT cors: invalid JSON body');
    sendJson(res, 400, { error: { message: 'Invalid JSON body', code: 400 } });
    return;
  }

  if (!Array.isArray(body['origins'])) {
    sendJson(res, 400, { error: { message: '"origins" must be an array of strings', code: 400 } });
    return;
  }

  const origins = (body['origins'] as unknown[]).filter(
    (o): o is string => typeof o === 'string' && o.trim().length > 0,
  );

  try {
    setCorsOrigins(origins);
  } catch (err) {
    log.error({ err }, 'PUT cors: failed to persist');
    sendJson(res, 500, { error: { message: 'Failed to save CORS config', code: 500 } });
    return;
  }

  log.info({ origins }, 'CORS origins updated');
  sendJson(res, 200, { origins });
});

// ---------------------------------------------------------------------------
// GET /api/admin/security/credentials
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/security/credentials', async (_req, res) => {
  log.debug('GET /api/admin/security/credentials');

  const credentials = SENSITIVE_KEYS.map((key) => {
    const value = process.env[key];
    return {
      key,
      present: typeof value === 'string' && value.length > 0,
      masked: value ? maskValue(value) : null,
    };
  });

  sendJson(res, 200, { credentials });
});

// ---------------------------------------------------------------------------
// GET /api/admin/security/access-log
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/security/access-log', async (_req, res) => {
  log.debug('GET /api/admin/security/access-log');

  // Placeholder: a real implementation would parse the pino log file and
  // filter for admin endpoint requests.
  sendJson(res, 200, {
    entries: [],
    total: 0,
    note: 'Live access log requires log-file parsing — showing placeholder',
  });
});
