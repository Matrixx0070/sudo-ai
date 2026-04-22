/**
 * @file security/vault-routes.ts
 * @description REST endpoints for MCP credential vault (Wave 5 P2).
 *
 * Endpoints:
 *   POST   /v1/vaults/:ns/credentials           — add credential
 *   GET    /v1/vaults/:ns/credentials           — list (metadata only, NO secrets)
 *   GET    /v1/vaults/:ns/credentials/:id       — retrieve metadata
 *   POST   /v1/vaults/:ns/credentials/:id       — rotate (new secret value)
 *   POST   /v1/vaults/:ns/credentials/:id/archive — archive (purges secret)
 *
 * Auth: GATEWAY_TOKEN bearer (timing-safe).  All /v1/vaults/* require auth when set.
 *
 * Errors:
 *   400 — invalid params / missing fields
 *   401 — unauthorized
 *   404 — credential not found
 *   409 — URL conflict / archived
 *   500 — internal server error
 */

import { timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { CredentialStore, CredentialError } from './vault-credentials.js';
import type { CredentialAuth } from './vault-credentials.js';

const log = createLogger('vault-routes');

const MAX_BODY = 128 * 1024; // 128 KB
const VAULT_BASE = '/v1/vaults';

// ---------------------------------------------------------------------------
// Auth helpers (same pattern as sessions/routes.ts)
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
  sendJson(res, status, { error: message });
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleAdd(
  req: IncomingMessage,
  res: ServerResponse,
  ns: string,
): Promise<void> {
  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  const b = body as Record<string, unknown>;
  const auth = b['auth'] as CredentialAuth | undefined;
  if (!auth || !auth.type || !auth.mcp_server_url) {
    sendError(res, 400, 'auth.type and auth.mcp_server_url are required');
    return;
  }

  try {
    const store = new CredentialStore(ns);
    const meta = await store.add(auth, b['display_name'] as string | undefined);
    sendJson(res, 201, meta);
  } catch (err) {
    if (err instanceof CredentialError) {
      sendError(res, err.statusCode, err.message);
    } else {
      log.error({ err: String(err), ns }, 'handleAdd error');
      sendError(res, 500, 'Internal server error');
    }
  }
}

function handleList(
  _req: IncomingMessage,
  res: ServerResponse,
  ns: string,
): void {
  try {
    const store = new CredentialStore(ns);
    const list = store.list();
    sendJson(res, 200, { credentials: list, total: list.length });
  } catch (err) {
    if (err instanceof CredentialError) {
      sendError(res, err.statusCode, err.message);
    } else {
      log.error({ err: String(err), ns }, 'handleList error');
      sendError(res, 500, 'Internal server error');
    }
  }
}

function handleGetMeta(
  _req: IncomingMessage,
  res: ServerResponse,
  ns: string,
  id: string,
): void {
  try {
    const store = new CredentialStore(ns);
    const meta = store.getMeta(id);
    sendJson(res, 200, meta);
  } catch (err) {
    if (err instanceof CredentialError) {
      sendError(res, err.statusCode, err.message);
    } else {
      log.error({ err: String(err), ns, id }, 'handleGetMeta error');
      sendError(res, 500, 'Internal server error');
    }
  }
}

async function handleRotate(
  req: IncomingMessage,
  res: ServerResponse,
  ns: string,
  id: string,
): Promise<void> {
  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  const b = body as Record<string, unknown>;
  const auth = (b['auth'] ?? {}) as Record<string, unknown>;

  try {
    const store = new CredentialStore(ns);
    const updated = await store.rotate(id, auth as Partial<CredentialAuth>);
    sendJson(res, 200, updated);
  } catch (err) {
    if (err instanceof CredentialError) {
      sendError(res, err.statusCode, err.message);
    } else {
      log.error({ err: String(err), ns, id }, 'handleRotate error');
      sendError(res, 500, 'Internal server error');
    }
  }
}

async function handleArchive(
  _req: IncomingMessage,
  res: ServerResponse,
  ns: string,
  id: string,
): Promise<void> {
  try {
    const store = new CredentialStore(ns);
    const updated = await store.archive(id);
    sendJson(res, 200, updated);
  } catch (err) {
    if (err instanceof CredentialError) {
      sendError(res, err.statusCode, err.message);
    } else {
      log.error({ err: String(err), ns, id }, 'handleArchive error');
      sendError(res, 500, 'Internal server error');
    }
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Attach vault credential REST routes to an existing http.Server.
 * Non-matching routes fall through to other listeners.
 *
 * @param app - Existing http.Server
 */
export function registerVaultCredentialRoutes(app: HttpServer): void {
  const tokenBuf = getTokenBuf();

  app.on('request', (req: IncomingMessage, res: ServerResponse): void => {
    const method = req.method ?? '';
    const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
    const pathname = rawPath.replace(/\/$/, '') || '/';

    // Only handle /v1/vaults/* paths
    if (!pathname.startsWith(VAULT_BASE)) return;

    // Auth gate
    if (!isAuthorised(req, tokenBuf)) {
      sendError(res, 401, 'Unauthorized: invalid or missing bearer token');
      return;
    }

    // Parse path: /v1/vaults/:ns/credentials[/:id][/archive]
    const rest = pathname.slice(VAULT_BASE.length).replace(/^\//, '');
    // rest = ":ns/credentials" | ":ns/credentials/:id" | ":ns/credentials/:id/archive"
    const parts = rest.split('/');
    const ns = parts[0] ?? '';
    const resource = parts[1] ?? '';
    const id = parts[2] ?? '';
    const action = parts[3] ?? '';

    if (!ns || resource !== 'credentials') return; // not our path shape

    const wrap = (p: Promise<void>) => p.catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Unhandled vault route error');
      if (!res.headersSent) sendError(res, 500, 'Internal server error');
    });

    // POST /v1/vaults/:ns/credentials — add
    if (method === 'POST' && !id) {
      wrap(handleAdd(req, res, ns));
      return;
    }

    // GET /v1/vaults/:ns/credentials — list
    if (method === 'GET' && !id) {
      handleList(req, res, ns);
      return;
    }

    // GET /v1/vaults/:ns/credentials/:id — get metadata
    if (method === 'GET' && id && !action) {
      handleGetMeta(req, res, ns, id);
      return;
    }

    // POST /v1/vaults/:ns/credentials/:id/archive — archive
    if (method === 'POST' && id && action === 'archive') {
      wrap(handleArchive(req, res, ns, id));
      return;
    }

    // POST /v1/vaults/:ns/credentials/:id — rotate
    if (method === 'POST' && id && !action) {
      wrap(handleRotate(req, res, ns, id));
      return;
    }

    // No route matched — fall through (do not call res.end)
  });

  log.info('Vault credential routes attached (/v1/vaults/:ns/credentials)');
}
