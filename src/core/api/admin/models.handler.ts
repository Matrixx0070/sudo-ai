/**
 * @file models.handler.ts
 * @description Admin API handlers for the /api/admin/models/* endpoints.
 *
 * Routes registered (override stubs in admin-router.ts):
 *   GET  /api/admin/models/config
 *   PUT  /api/admin/models/config
 *   GET  /api/admin/models/providers
 *   POST /api/admin/models/providers/:id/test
 *   PUT  /api/admin/models/providers/:id/key
 *   GET  /api/admin/models/cost
 */

import path from 'node:path';
import { adminRouter, sendJson, readJsonBody } from '../admin-router.js';
import { readConfig, writeConfig, updateEnvVar } from './config-io.js';
import { createLogger } from '../../shared/logger.js';
import { DATA_DIR } from '../../shared/paths.js';

const log = createLogger('api:admin:models');


interface ProviderMeta {
  id: string;
  name: string;
  envKey: string;
  testUrl: string;
  authScheme: 'bearer' | 'x-api-key' | 'google';
}

const PROVIDERS: ProviderMeta[] = [
  { id: 'xai',       name: 'xAI (Grok)',       envKey: 'XAI_API_KEY',       testUrl: 'https://api.x.ai/v1/models',                                         authScheme: 'bearer'   },
  { id: 'openai',    name: 'OpenAI',            envKey: 'OPENAI_API_KEY',    testUrl: 'https://api.openai.com/v1/models',                                    authScheme: 'bearer'   },
  { id: 'anthropic', name: 'Anthropic',         envKey: 'ANTHROPIC_API_KEY', testUrl: 'https://api.anthropic.com/v1/models',                                 authScheme: 'x-api-key'},
  { id: 'google',    name: 'Google (Gemini)',   envKey: 'GEMINI_API_KEY',    testUrl: 'https://generativelanguage.googleapis.com/v1beta/models',             authScheme: 'google'   },
];

function findProvider(id: string): ProviderMeta | undefined {
  return PROVIDERS.find(p => p.id === id);
}

// --- GET /api/admin/models/config -------------------------------------------
adminRouter.get('/api/admin/models/config', async (_req, res) => {
  log.debug('GET /api/admin/models/config');
  try {
    const config = readConfig();
    sendJson(res, 200, { status: 'ok', data: config['models'] ?? {} });
  } catch (err) {
    log.error({ err }, 'GET models/config failed');
    sendJson(res, 500, { error: { message: (err as Error).message, code: 500 } });
  }
});

// --- PUT /api/admin/models/config -------------------------------------------

adminRouter.put('/api/admin/models/config', async (req, res) => {
  log.debug('PUT /api/admin/models/config');
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: { message: (err as Error).message, code: 400 } });
    return;
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: { message: 'Request body must be a JSON object', code: 400 } });
    return;
  }

  const update = body as Record<string, unknown>;

  // Require at least one recognised key to avoid accidental wipes
  const knownKeys = ['primary', 'fallback', 'embedding'];
  const hasKnown = knownKeys.some(k => k in update);
  if (!hasKnown) {
    sendJson(res, 400, {
      error: { message: `Body must contain at least one of: ${knownKeys.join(', ')}`, code: 400 },
    });
    return;
  }

  try {
    const config = readConfig();
    const existing = (config['models'] ?? {}) as Record<string, unknown>;
    config['models'] = { ...existing, ...update };
    writeConfig(config);
    log.info({ keys: Object.keys(update) }, 'Models config updated');
    sendJson(res, 200, { status: 'ok', data: config['models'] });
  } catch (err) {
    log.error({ err }, 'PUT models/config failed');
    sendJson(res, 500, { error: { message: (err as Error).message, code: 500 } });
  }
});

// --- GET /api/admin/models/providers ----------------------------------------

adminRouter.get('/api/admin/models/providers', async (_req, res) => {
  log.debug('GET /api/admin/models/providers');
  try {
    const result = PROVIDERS.map(p => ({
      id: p.id,
      name: p.name,
      envKey: p.envKey,
      hasKey: Boolean(process.env[p.envKey]),
    }));
    sendJson(res, 200, { status: 'ok', data: result });
  } catch (err) {
    log.error({ err }, 'GET models/providers failed');
    sendJson(res, 500, { error: { message: (err as Error).message, code: 500 } });
  }
});

// --- POST /api/admin/models/providers/:id/test ------------------------------

adminRouter.post('/api/admin/models/providers/:id/test', async (_req, res, params) => {
  const { id } = params;
  log.debug({ id }, 'POST models/providers/test');

  const provider = findProvider(id ?? '');
  if (!provider) {
    sendJson(res, 404, { error: { message: `Unknown provider: ${id}`, code: 404 } });
    return;
  }

  const apiKey = process.env[provider.envKey];
  if (!apiKey) {
    sendJson(res, 422, {
      error: { message: `No API key set for provider "${id}" (env: ${provider.envKey})`, code: 422 },
    });
    return;
  }

  // Build headers
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.authScheme === 'bearer') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (provider.authScheme === 'x-api-key') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider.authScheme === 'google') {
    headers['x-goog-api-key'] = apiKey;
  }

  const start = Date.now();
  try {
    const response = await fetch(provider.testUrl, { method: 'GET', headers, signal: AbortSignal.timeout(10_000) });
    const latencyMs = Date.now() - start;
    if (response.ok) {
      log.info({ id, latencyMs, status: response.status }, 'Provider connection test passed');
      sendJson(res, 200, { status: 'ok', data: { provider: id, connected: true, latencyMs, httpStatus: response.status } });
    } else {
      const body = await response.text().catch(() => '');
      log.warn({ id, httpStatus: response.status, body }, 'Provider connection test returned non-2xx');
      sendJson(res, 200, {
        status: 'ok',
        data: { provider: id, connected: false, latencyMs, httpStatus: response.status, detail: body.slice(0, 300) },
      });
    }
  } catch (err) {
    const latencyMs = Date.now() - start;
    log.error({ err, id }, 'Provider connection test threw');
    sendJson(res, 200, {
      status: 'ok',
      data: { provider: id, connected: false, latencyMs, error: (err as Error).message },
    });
  }
});

// --- PUT /api/admin/models/providers/:id/key --------------------------------

adminRouter.put('/api/admin/models/providers/:id/key', async (req, res, params) => {
  const { id } = params;
  log.debug({ id }, 'PUT models/providers/key');

  const provider = findProvider(id ?? '');
  if (!provider) {
    sendJson(res, 404, { error: { message: `Unknown provider: ${id}`, code: 404 } });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: { message: (err as Error).message, code: 400 } });
    return;
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: { message: 'Request body must be a JSON object', code: 400 } });
    return;
  }

  const b = body as Record<string, unknown>;
  const apiKey = b['key'];
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    sendJson(res, 400, { error: { message: 'Body must contain a non-empty string field "key"', code: 400 } });
    return;
  }

  try {
    updateEnvVar(provider.envKey, apiKey.trim());
    log.info({ id, envKey: provider.envKey }, 'Provider API key updated');
    sendJson(res, 200, { status: 'ok', data: { provider: id, envKey: provider.envKey, updated: true } });
  } catch (err) {
    log.error({ err, id }, 'PUT providers/key failed');
    sendJson(res, 500, { error: { message: (err as Error).message, code: 500 } });
  }
});

// --- GET /api/admin/models/cost ---------------------------------------------

const DB_PATH = path.join(DATA_DIR, 'knowledge.db');

interface CostRecord {
  provider: string;
  total_usd: number;
  request_count: number;
}

interface CostSummary {
  today: CostRecord[];
  week: CostRecord[];
  month: CostRecord[];
  allTime: CostRecord[];
  source: 'database' | 'placeholder';
}

adminRouter.get('/api/admin/models/cost', async (_req, res) => {
  log.debug('GET /api/admin/models/cost');

  const placeholder: CostSummary = {
    today: [],
    week: [],
    month: [],
    allTime: [],
    source: 'placeholder',
  };

  let db: import('better-sqlite3').Database | undefined;
  try {
    const { default: Database } = await import('better-sqlite3') as { default: typeof import('better-sqlite3') };
    db = new Database(DB_PATH, { readonly: true });

    const tableExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='api_costs'`,
    ).get();

    if (!tableExists) {
      log.warn('api_costs table not found in knowledge.db — returning placeholder');
      sendJson(res, 200, { status: 'ok', data: placeholder });
      return;
    }

    const conn = db;
    const queryCosts = (since: string): CostRecord[] => {
      return conn.prepare(`
        SELECT provider,
               COALESCE(SUM(cost_usd), 0)    AS total_usd,
               COUNT(*)                       AS request_count
        FROM api_costs
        WHERE created_at >= ?
        GROUP BY provider
        ORDER BY total_usd DESC
      `).all(since) as CostRecord[];
    };

    const now = new Date();
    const todayStart  = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart   = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const monthStart  = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const epochStart  = '1970-01-01T00:00:00.000Z';

    const summary: CostSummary = {
      today:   queryCosts(todayStart),
      week:    queryCosts(weekStart),
      month:   queryCosts(monthStart),
      allTime: queryCosts(epochStart),
      source:  'database',
    };

    log.info('Cost data fetched from knowledge.db');
    sendJson(res, 200, { status: 'ok', data: summary });
  } catch (err) {
    log.warn({ err }, 'GET models/cost: DB unavailable — returning placeholder');
    sendJson(res, 200, { status: 'ok', data: placeholder });
  } finally {
    if (db) db.close();
  }
});
