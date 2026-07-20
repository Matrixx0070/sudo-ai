/**
 * @file admin-grok-routes.ts
 * @description GP6 — admin REST routes backing the web model-picker dropdown for
 * the two independent Grok providers (`xai-oauth` subscription seat, `xai`
 * metered API key). Mirrors admin-claude-oauth-routes.ts (inline auth + the
 * headers-sent guard). Read-only w.r.t. credentials — never returns key material.
 *
 * Routes (all under /v1/admin/grok, timing-safe Bearer):
 *   GET /v1/admin/grok/status                         — both providers' state
 *   GET /v1/admin/grok/models?method=oauth|apikey[&refresh=1]
 *                                                     — live/cached model list
 *   PUT /v1/admin/grok/default-model {method,modelId} — pick the default
 */

import { timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { getXaiOAuthManager } from '../../llm/xai-oauth-manager.js';
import { getXaiApiKeyManager } from '../../llm/xai-apikey-manager.js';
import { getXaiModelDiscovery, XaiNotConnectedError, type XaiAuthMethod } from '../../llm/xai-models.js';

const log = createLogger('gateway:admin-grok');

const MAX_BODY = 64 * 1024;

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
  // Shared-server guard: a second writeHead after another listener responded
  // throws ERR_HTTP_HEADERS_SENT and can take the daemon down (see the
  // claude-oauth routes' note). Skip if already written.
  if (res.headersSent || res.writableEnded) {
    log.warn({ status }, 'sendJson skipped — response already written by another listener');
    return;
  }
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
// Method resolution — one place; both methods share the same manager contract.
// ---------------------------------------------------------------------------

interface GrokMethodMgr {
  connected: boolean;
  listModels: () => ReturnType<ReturnType<typeof getXaiOAuthManager>['listModels']>;
  setModels: (m: ReturnType<ReturnType<typeof getXaiOAuthManager>['listModels']>) => void;
  getDefaultModel: () => string | null;
  setDefaultModel: (id: string) => boolean;
}

function resolveMethod(raw: string | null): XaiAuthMethod | null {
  return raw === 'oauth' || raw === 'apikey' ? raw : null;
}

function managerFor(method: XaiAuthMethod): GrokMethodMgr {
  if (method === 'oauth') {
    const m = getXaiOAuthManager();
    return {
      connected: m.status().connected,
      listModels: () => m.listModels(),
      setModels: (x) => m.setModels(x),
      getDefaultModel: () => m.getDefaultModel(),
      setDefaultModel: (id) => m.setDefaultModel(id),
    };
  }
  const m = getXaiApiKeyManager();
  return {
    connected: m.status().connected,
    listModels: () => m.listModels(),
    setModels: (x) => m.setModels(x),
    getDefaultModel: () => m.getDefaultModel(),
    setDefaultModel: (id) => m.setDefaultModel(id),
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleStatus(res: ServerResponse): void {
  const oauth = getXaiOAuthManager();
  const api = getXaiApiKeyManager();
  const os = oauth.status();
  const as = api.status();
  sendJson(res, 200, {
    ok: true,
    data: {
      providers: [
        {
          provider: 'xai-oauth',
          label: 'Sign in with Grok (subscription)',
          connected: os.connected,
          needsRelogin: os.needsRelogin === true,
          defaultModel: oauth.getDefaultModel(),
          modelsCount: oauth.listModels().length,
          billing: 'subscription',
        },
        {
          provider: 'xai',
          label: 'Grok API Key (metered)',
          connected: as.connected,
          source: as.source,
          defaultModel: api.getDefaultModel(),
          modelsCount: as.modelsCount,
          billing: 'metered',
        },
      ],
    },
  });
}

async function handleModelsGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = resolveMethod(url.searchParams.get('method'));
  if (!method) {
    sendError(res, 400, 'method query param must be "oauth" or "apikey"');
    return;
  }
  const mgr = managerFor(method);
  if (!mgr.connected) {
    sendError(res, 400, `${method} not connected — onboard it first`);
    return;
  }
  const wantRefresh = url.searchParams.get('refresh') === '1';
  try {
    let models = mgr.listModels();
    if (wantRefresh || models.length === 0) {
      models = await getXaiModelDiscovery().refresh(method);
      mgr.setModels(models);
    }
    sendJson(res, 200, { ok: true, data: { method, models, defaultModel: mgr.getDefaultModel() } });
  } catch (err) {
    if (err instanceof XaiNotConnectedError) {
      sendError(res, 400, err.message);
      return;
    }
    sendError(res, 502, err instanceof Error ? err.message : String(err));
  }
}

async function handleDefaultModelPut(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    const raw = await readBody(req);
    body = raw.length > 0 ? (JSON.parse(raw) as unknown) : {};
  } catch {
    sendError(res, 400, 'Invalid or oversized request body');
    return;
  }
  const b = body as Record<string, unknown>;
  const method = resolveMethod(typeof b['method'] === 'string' ? (b['method'] as string) : null);
  const id = b['modelId'];
  if (!method) {
    sendError(res, 400, 'method must be "oauth" or "apikey"');
    return;
  }
  if (typeof id !== 'string' || id.trim().length === 0) {
    sendError(res, 400, 'modelId (string) is required');
    return;
  }
  const mgr = managerFor(method);
  if (!mgr.connected) {
    sendError(res, 400, `${method} not connected — onboard it first`);
    return;
  }
  if (!mgr.setDefaultModel(id.trim())) {
    sendError(res, 400, `Model id "${id.trim()}" is not in the cached list — refresh models and retry`);
    return;
  }
  sendJson(res, 200, { ok: true, data: { method, defaultModel: mgr.getDefaultModel() } });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAdminGrokRoutes(server: HttpServer, tokenBuf: Buffer | null): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? '';
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    if (!pathname.startsWith('/v1/admin/grok')) return;

    if (!isAuthorised(req, tokenBuf)) {
      sendError(res, 401, 'Unauthorized: invalid or missing bearer token');
      return;
    }

    if (method === 'GET' && pathname === '/v1/admin/grok/status') {
      handleStatus(res);
      return;
    }
    if (method === 'GET' && pathname === '/v1/admin/grok/models') {
      handleModelsGet(req, res).catch((err: unknown) => {
        log.error({ err: String(err) }, 'Unhandled error in grok models');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }
    if (method === 'PUT' && pathname === '/v1/admin/grok/default-model') {
      handleDefaultModelPut(req, res).catch((err: unknown) => {
        log.error({ err: String(err) }, 'Unhandled error in grok default-model');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    sendError(res, 404, 'Unknown grok admin route');
  });

  log.info('Admin Grok routes registered: status, models, default-model');
}
