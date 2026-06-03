/**
 * Credential Pool — REST route handlers.
 *
 * Routes:
 *   GET  /v1/admin/credentials/pool                  — list all pools + status
 *   GET  /v1/admin/credentials/pool/:provider        — pool status for provider
 *   POST /v1/admin/credentials/pool/:provider/strategy — set strategy
 *   POST /v1/admin/credentials/pool/:provider/add    — add credential
 *   DELETE /v1/admin/credentials/pool/:provider/:id  — remove credential
 *
 * Auth: GATEWAY_TOKEN bearer (timing-safe). All /v1/admin/credentials/* require auth.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { credentialPool } from './credential-pool.js';
import type { SelectionStrategy, AddCredentialRequest, SetStrategyRequest } from './credential-pool-types.js';

const log = createLogger('auth:credential-pool-routes');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BODY = 64 * 1024; // 64 KB
const CREDENTIALS_BASE = '/v1/admin/credentials';

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
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /v1/admin/credentials/pool
 * List all credential pools with status.
 */
function handleListPools(req: IncomingMessage, res: ServerResponse, tokenBuf: Buffer | null): void {
  if (!isAuthorised(req, tokenBuf)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  try {
    const allStatus = credentialPool.getAllStatus();
    const result: Record<string, unknown> = {};

    for (const [provider, status] of allStatus.entries()) {
      result[provider] = {
        ...status,
        credentials: credentialPool.getCredentials(provider),
      };
    }

    sendJson(res, 200, { ok: true, data: result });
    log.info({ poolCount: allStatus.size }, 'Listed all credential pools');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to list pools');
    sendError(res, 500, 'Internal server error');
  }
}

/**
 * GET /v1/admin/credentials/pool/:provider
 * Get status for a specific provider pool.
 */
function handleGetPool(
  req: IncomingMessage,
  res: ServerResponse,
  tokenBuf: Buffer | null,
  provider: string,
): void {
  if (!isAuthorised(req, tokenBuf)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  try {
    const status = credentialPool.getPoolStatus(provider);
    const credentials = credentialPool.getCredentials(provider);

    if (status.total === 0) {
      sendError(res, 404, `No pool found for provider: ${provider}`);
      return;
    }

    sendJson(res, 200, { ok: true, data: { ...status, credentials } });
    log.info({ provider, total: status.total }, 'Retrieved pool status');
  } catch (err: unknown) {
    log.error({ provider, err: err instanceof Error ? err.message : String(err) }, 'Failed to get pool');
    sendError(res, 500, 'Internal server error');
  }
}

/**
 * POST /v1/admin/credentials/pool/:provider/strategy
 * Set selection strategy for a provider pool.
 */
async function handleSetStrategy(
  req: IncomingMessage,
  res: ServerResponse,
  tokenBuf: Buffer | null,
  provider: string,
): Promise<void> {
  if (!isAuthorised(req, tokenBuf)) {
    sendError(res, 401, 'Unauthorized');
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

  let parsed: SetStrategyRequest;
  try {
    parsed = JSON.parse(bodyText) as SetStrategyRequest;
  } catch {
    sendError(res, 400, 'Invalid JSON');
    return;
  }

  const validStrategies: SelectionStrategy[] = ['fill-first', 'round-robin', 'least-used', 'random'];
  if (!parsed.strategy || !validStrategies.includes(parsed.strategy)) {
    sendError(res, 400, `strategy must be one of: ${validStrategies.join(', ')}`);
    return;
  }

  try {
    credentialPool.setStrategy(provider, parsed.strategy);
    const status = credentialPool.getPoolStatus(provider);
    sendJson(res, 200, { ok: true, data: status });
    log.info({ provider, strategy: parsed.strategy }, 'Strategy updated');
  } catch (err: unknown) {
    log.error({ provider, err: err instanceof Error ? err.message : String(err) }, 'Failed to set strategy');
    sendError(res, 500, 'Internal server error');
  }
}

/**
 * POST /v1/admin/credentials/pool/:provider/add
 * Add a new credential to a provider pool.
 */
async function handleAddCredential(
  req: IncomingMessage,
  res: ServerResponse,
  tokenBuf: Buffer | null,
  provider: string,
): Promise<void> {
  if (!isAuthorised(req, tokenBuf)) {
    sendError(res, 401, 'Unauthorized');
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

  let parsed: AddCredentialRequest;
  try {
    parsed = JSON.parse(bodyText) as AddCredentialRequest;
  } catch {
    sendError(res, 400, 'Invalid JSON');
    return;
  }

  if (!parsed.id || typeof parsed.id !== 'string' || parsed.id.trim() === '') {
    sendError(res, 400, 'id is required and must be a non-empty string');
    return;
  }

  if (!parsed.key || typeof parsed.key !== 'string' || parsed.key.trim() === '') {
    sendError(res, 400, 'key is required and must be a non-empty string');
    return;
  }

  try {
    credentialPool.addCredential(parsed.id, provider, parsed.key);
    const status = credentialPool.getPoolStatus(provider);
    sendJson(res, 200, { ok: true, data: status });
    log.info({ provider, id: parsed.id }, 'Credential added');
  } catch (err: unknown) {
    log.error({ provider, id: parsed.id, err: err instanceof Error ? err.message : String(err) }, 'Failed to add credential');
    sendError(res, 500, 'Internal server error');
  }
}

/**
 * DELETE /v1/admin/credentials/pool/:provider/:credentialId
 * Remove a credential from a provider pool.
 */
function handleRemoveCredential(
  req: IncomingMessage,
  res: ServerResponse,
  tokenBuf: Buffer | null,
  provider: string,
  credentialId: string,
): void {
  if (!isAuthorised(req, tokenBuf)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  try {
    const removed = credentialPool.removeCredential(credentialId);
    if (!removed) {
      sendError(res, 404, `Credential not found: ${credentialId}`);
      return;
    }

    const status = credentialPool.getPoolStatus(provider);
    sendJson(res, 200, { ok: true, data: status });
    log.info({ provider, id: credentialId }, 'Credential removed');
  } catch (err: unknown) {
    log.error({ provider, id: credentialId, err: err instanceof Error ? err.message : String(err) }, 'Failed to remove credential');
    sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Register credential pool routes with an HTTP server.
 *
 * @param server - The HTTP server instance.
 */
export function registerCredentialPoolRoutes(server: HttpServer): void {
  const tokenBuf = getTokenBuf();

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url ?? '/';
    const urlObj = new URL(rawUrl, 'http://localhost');
    const pathname = urlObj.pathname;

    // GET /v1/admin/credentials/pool
    if (pathname === `${CREDENTIALS_BASE}/pool` && req.method === 'GET') {
      handleListPools(req, res, tokenBuf);
      return;
    }

    // GET /v1/admin/credentials/pool/:provider
    const poolMatch = pathname.match(/^\/v1\/admin\/credentials\/pool\/([^/]+)$/);
    if (poolMatch && req.method === 'GET') {
      const provider = decodeURIComponent(poolMatch[1]);
      handleGetPool(req, res, tokenBuf, provider);
      return;
    }

    // POST /v1/admin/credentials/pool/:provider/strategy
    const strategyMatch = pathname.match(/^\/v1\/admin\/credentials\/pool\/([^/]+)\/strategy$/);
    if (strategyMatch && req.method === 'POST') {
      const provider = decodeURIComponent(strategyMatch[1]);
      handleSetStrategy(req, res, tokenBuf, provider).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Strategy handler error');
        sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // POST /v1/admin/credentials/pool/:provider/add
    const addMatch = pathname.match(/^\/v1\/admin\/credentials\/pool\/([^/]+)\/add$/);
    if (addMatch && req.method === 'POST') {
      const provider = decodeURIComponent(addMatch[1]);
      handleAddCredential(req, res, tokenBuf, provider).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Add credential handler error');
        sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // DELETE /v1/admin/credentials/pool/:provider/:credentialId
    const deleteMatch = pathname.match(/^\/v1\/admin\/credentials\/pool\/([^/]+)\/([^/]+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      const provider = decodeURIComponent(deleteMatch[1]);
      const credentialId = decodeURIComponent(deleteMatch[2]);
      handleRemoveCredential(req, res, tokenBuf, provider, credentialId);
      return;
    }
  });

  log.info('Credential pool routes registered');
}
