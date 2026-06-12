/**
 * @file channels.handler.ts
 * @description Admin API route handlers for /api/admin/channels/* endpoints.
 *
 * Config I/O helpers live in channels.config.ts to stay within the 300-line
 * per-file limit and keep concerns separated.
 *
 * Routes registered (overriding stubs in admin-router.ts):
 *   GET  /api/admin/channels
 *   PUT  /api/admin/channels/:type
 *   POST /api/admin/channels/:type/toggle
 *   POST /api/admin/channels/:type/test
 *   GET  /api/admin/channels/:type/messages
 */

import path from 'node:path';
import type BetterSqlite3T from 'better-sqlite3';
import { adminRouter, sendJson, readJsonBody } from '../admin-router.js';
import { createLogger } from '../../shared/logger.js';
import { DATA_DIR } from '../../shared/paths.js';
import {
  CHANNEL_TYPES,
  readConfig,
  writeConfig,
  getChannelConfig,
  isLikelyConnected,
} from './channels.config.js';

const log = createLogger('api:admin:channels');

const MIND_DB_PATH = path.join(DATA_DIR, 'mind.db');

// ---------------------------------------------------------------------------
// GET /api/admin/channels
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/channels', async (_req, res, _params) => {
  log.debug('GET /api/admin/channels');

  let cfg: Record<string, unknown>;
  try {
    cfg = readConfig();
  } catch (err) {
    log.error({ err }, 'GET /api/admin/channels: config read failed');
    sendJson(res, 500, { error: { message: 'Could not read config', code: 500 } });
    return;
  }

  const list = CHANNEL_TYPES.map(({ type, name, icon }) => {
    const channelCfg = getChannelConfig(cfg, type);
    const enabled = Boolean(channelCfg['enabled'] ?? false);
    return {
      type,
      name,
      icon,
      enabled,
      connected: enabled && isLikelyConnected(type, channelCfg),
      config: channelCfg,
    };
  });

  sendJson(res, 200, { channels: list });
});

// ---------------------------------------------------------------------------
// PUT /api/admin/channels/:type
// ---------------------------------------------------------------------------

adminRouter.put('/api/admin/channels/:type', async (req, res, params) => {
  const { type } = params;
  log.debug({ type }, 'PUT /api/admin/channels/:type');

  if (!type || !CHANNEL_TYPES.some((c) => c.type === type)) {
    sendJson(res, 400, { error: { message: `Unknown channel type: ${type}`, code: 400 } });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: { message: err instanceof Error ? err.message : 'Bad request body', code: 400 } });
    return;
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { error: { message: 'Request body must be a JSON object', code: 400 } });
    return;
  }

  let cfg: Record<string, unknown>;
  try {
    cfg = readConfig();
  } catch {
    sendJson(res, 500, { error: { message: 'Could not read config', code: 500 } });
    return;
  }

  if (typeof cfg['channels'] !== 'object' || cfg['channels'] === null) {
    cfg['channels'] = {};
  }
  const channels = cfg['channels'] as Record<string, unknown>;
  const existing = (channels[type] as Record<string, unknown>) ?? {};
  channels[type] = { ...existing, ...(body as Record<string, unknown>) };

  try {
    writeConfig(cfg);
  } catch {
    sendJson(res, 500, { error: { message: 'Config write failed', code: 500 } });
    return;
  }

  log.info({ type }, 'Channel config updated');
  sendJson(res, 200, { ok: true, type, config: channels[type] });
});

// ---------------------------------------------------------------------------
// POST /api/admin/channels/:type/toggle
// ---------------------------------------------------------------------------

adminRouter.post('/api/admin/channels/:type/toggle', async (req, res, params) => {
  const { type } = params;
  log.debug({ type }, 'POST /api/admin/channels/:type/toggle');

  if (!type || !CHANNEL_TYPES.some((c) => c.type === type)) {
    sendJson(res, 400, { error: { message: `Unknown channel type: ${type}`, code: 400 } });
    return;
  }

  let forcedEnabled: boolean | undefined;
  try {
    const parsed = await readJsonBody(req);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const p = parsed as Record<string, unknown>;
      if (typeof p['enabled'] === 'boolean') forcedEnabled = p['enabled'];
    }
  } catch {
    // Non-fatal — will flip current value
  }

  let cfg: Record<string, unknown>;
  try {
    cfg = readConfig();
  } catch {
    sendJson(res, 500, { error: { message: 'Could not read config', code: 500 } });
    return;
  }

  if (typeof cfg['channels'] !== 'object' || cfg['channels'] === null) {
    cfg['channels'] = {};
  }
  const channels = cfg['channels'] as Record<string, unknown>;
  const existing = (channels[type] as Record<string, unknown>) ?? {};
  const newEnabled =
    forcedEnabled !== undefined ? forcedEnabled : !Boolean(existing['enabled'] ?? false);
  channels[type] = { ...existing, enabled: newEnabled };

  try {
    writeConfig(cfg);
  } catch {
    sendJson(res, 500, { error: { message: 'Config write failed', code: 500 } });
    return;
  }

  log.info({ type, enabled: newEnabled }, 'Channel toggled');
  sendJson(res, 200, { ok: true, type, enabled: newEnabled });
});

// ---------------------------------------------------------------------------
// POST /api/admin/channels/:type/test
// ---------------------------------------------------------------------------

adminRouter.post('/api/admin/channels/:type/test', async (_req, res, params) => {
  const { type } = params;
  log.debug({ type }, 'POST /api/admin/channels/:type/test');

  if (!type || !CHANNEL_TYPES.some((c) => c.type === type)) {
    sendJson(res, 400, { error: { message: `Unknown channel type: ${type}`, code: 400 } });
    return;
  }

  // Channel adapters are not wired into the admin API; answering 200 ok here
  // would claim a send that never happens (see PR #76 stub-honesty precedent).
  log.info({ type }, 'Channel test requested — not implemented');
  sendJson(res, 501, {
    error: {
      message: 'Not implemented — channel adapters are not wired into the admin API; no test message was sent',
      code: 501,
    },
    type,
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/channels/:type/messages
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/channels/:type/messages', async (req, res, params) => {
  const { type } = params;
  log.debug({ type }, 'GET /api/admin/channels/:type/messages');

  if (!type || !CHANNEL_TYPES.some((c) => c.type === type)) {
    sendJson(res, 400, { error: { message: `Unknown channel type: ${type}`, code: 400 } });
    return;
  }

  const urlObj = new URL(req.url ?? '/', 'http://localhost');
  const rawLimit = urlObj.searchParams.get('limit');
  const limit = rawLimit
    ? Math.min(Math.max(parseInt(rawLimit, 10) || 50, 1), 200)
    : 50;

  let messages: unknown[] = [];

  try {
    const mod = await import('better-sqlite3');
    // ESM dynamic import wraps CJS default export in { default: ... }
    const Database = (mod.default ?? mod) as typeof BetterSqlite3T;
    const db = new Database(MIND_DB_PATH, { readonly: true });

    try {
      // Resolve session IDs that belong to this channel type
      const sessionRows = db
        .prepare(
          `SELECT text FROM chunks
           WHERE path LIKE 'session:%:meta'
             AND source = 'conversation'
           ORDER BY rowid DESC`,
        )
        .all({}) as Array<{ text: string }>;

      const channelSessionIds: string[] = [];
      for (const row of sessionRows) {
        try {
          const meta = JSON.parse(row.text) as { id?: string; channel?: string };
          if (meta.channel === type && typeof meta.id === 'string') {
            channelSessionIds.push(meta.id);
          }
        } catch {
          // malformed chunk — skip
        }
      }

      if (channelSessionIds.length > 0) {
        const placeholders = channelSessionIds.map(() => '?').join(',');
        const msgRows = db
          .prepare(
            `SELECT session_id, role, content, created_at
             FROM messages
             WHERE session_id IN (${placeholders})
             ORDER BY rowid DESC
             LIMIT ?`,
          )
          .all([...channelSessionIds, limit]) as Array<{
            session_id: string;
            role: string;
            content: string;
            created_at?: string;
          }>;

        messages = msgRows.map((r) => ({
          sessionId: r.session_id,
          role: r.role,
          content: r.content.slice(0, 500),
          createdAt: r.created_at ?? null,
        }));
      }
    } finally {
      db.close();
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.warn({ err, type }, 'Could not query mind.db for channel messages');
    }
  }

  sendJson(res, 200, { type, messages, count: messages.length });
});
