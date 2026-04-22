/**
 * @file sessions.handler.ts
 * @description Admin API route handlers for /api/admin/sessions/* endpoints.
 *
 * DB helpers live in sessions.db-utils.ts.
 *
 * Session metadata is stored in the chunks table as JSON blobs at paths
 * matching 'session:<id>:meta' (written by SessionManager._persistToDb).
 * Messages are stored in the messages table (if present).
 *
 * Routes registered (overriding stubs in admin-router.ts):
 *   GET    /api/admin/sessions
 *   GET    /api/admin/sessions/:id
 *   DELETE /api/admin/sessions/:id
 */

import { adminRouter, sendJson } from '../admin-router.js';
import { createLogger } from '../../shared/logger.js';
import {
  openMindDb,
  parseSessionMetas,
  tableExists,
  type SessionMeta,
  type SessionMessage,
  type BetterSqliteRow,
} from './sessions.db-utils.js';

const log = createLogger('api:admin:sessions');

const MAX_MESSAGES = 100;

// ---------------------------------------------------------------------------
// GET /api/admin/sessions
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/sessions', async (req, res) => {
  log.debug('GET /api/admin/sessions');

  const urlObj = new URL(req.url ?? '/', 'http://localhost');
  const stateFilter = urlObj.searchParams.get('state') ?? 'active';
  const rawLimit = urlObj.searchParams.get('limit');
  const limit = rawLimit ? Math.min(Math.max(parseInt(rawLimit, 10) || 50, 1), 200) : 50;

  const validStates = new Set(['active', 'compacted', 'archived', 'all']);
  if (!validStates.has(stateFilter)) {
    sendJson(res, 400, {
      error: { message: `state must be one of: ${[...validStates].join(', ')}`, code: 400 },
    });
    return;
  }

  const db = await openMindDb({ readonly: true });
  if (!db) {
    sendJson(res, 200, { sessions: [], count: 0 });
    return;
  }

  try {
    if (!tableExists(db, 'chunks')) {
      sendJson(res, 200, { sessions: [], count: 0 });
      return;
    }

    const rows = db
      .prepare(
        `SELECT text FROM chunks
         WHERE path LIKE 'session:%:meta'
           AND source = 'conversation'
         ORDER BY rowid DESC`,
      )
      .all({}) as BetterSqliteRow[];

    let sessions = parseSessionMetas(rows);

    if (stateFilter !== 'all') {
      sessions = sessions.filter((s) => s.state === stateFilter);
    }
    sessions = sessions.slice(0, limit);

    sendJson(res, 200, { sessions, count: sessions.length });
  } catch (err) {
    log.error({ err }, 'GET /api/admin/sessions: query failed');
    sendJson(res, 500, { error: { message: 'Database query failed', code: 500 } });
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/sessions/:id
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/sessions/:id', async (_req, res, params) => {
  const { id } = params;
  log.debug({ id }, 'GET /api/admin/sessions/:id');

  if (!id) {
    sendJson(res, 400, { error: { message: 'Session id is required', code: 400 } });
    return;
  }

  const db = await openMindDb({ readonly: true });
  if (!db) {
    sendJson(res, 404, { error: { message: 'Session not found (database unavailable)', code: 404 } });
    return;
  }

  try {
    const metaRow = db
      .prepare(
        `SELECT text FROM chunks
         WHERE path = :path AND source = 'conversation'
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get({ path: `session:${id}:meta` }) as BetterSqliteRow | undefined;

    if (!metaRow) {
      sendJson(res, 404, { error: { message: `Session not found: ${id}`, code: 404 } });
      return;
    }

    let meta: SessionMeta;
    try {
      meta = JSON.parse(metaRow.text) as SessionMeta;
    } catch {
      log.error({ id }, 'Failed to parse session meta JSON');
      sendJson(res, 500, { error: { message: 'Corrupt session record', code: 500 } });
      return;
    }

    let messages: Omit<SessionMessage, 'session_id'>[] = [];

    if (tableExists(db, 'messages')) {
      const msgRows = db
        .prepare(
          `SELECT session_id, role, content, tool_name, created_at
           FROM messages
           WHERE session_id = :sid
           ORDER BY rowid ASC
           LIMIT :limit`,
        )
        .all({ sid: id, limit: MAX_MESSAGES }) as SessionMessage[];

      messages = msgRows.map((r) => ({
        role: r.role,
        content: r.content,
        toolName: r.tool_name ?? undefined,
        createdAt: r.created_at ?? null,
      }));
    }

    sendJson(res, 200, {
      session: { ...meta, messageCount: messages.length, messages },
    });
  } catch (err) {
    log.error({ err, id }, 'GET /api/admin/sessions/:id: query failed');
    sendJson(res, 500, { error: { message: 'Database query failed', code: 500 } });
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/sessions/:id
// ---------------------------------------------------------------------------

adminRouter.delete('/api/admin/sessions/:id', async (_req, res, params) => {
  const { id } = params;
  log.debug({ id }, 'DELETE /api/admin/sessions/:id');

  if (!id) {
    sendJson(res, 400, { error: { message: 'Session id is required', code: 400 } });
    return;
  }

  const db = await openMindDb({ readonly: false });
  if (!db) {
    sendJson(res, 404, {
      error: { message: 'Session not found (database unavailable)', code: 404 },
    });
    return;
  }

  try {
    const metaPath = `session:${id}:meta`;

    const existing = db
      .prepare(`SELECT text FROM chunks WHERE path = :path ORDER BY rowid DESC LIMIT 1`)
      .get({ path: metaPath }) as BetterSqliteRow | undefined;

    if (!existing) {
      sendJson(res, 404, { error: { message: `Session not found: ${id}`, code: 404 } });
      return;
    }

    let meta: SessionMeta;
    try {
      meta = JSON.parse(existing.text) as SessionMeta;
    } catch {
      log.error({ id }, 'Failed to parse session meta on delete');
      sendJson(res, 500, { error: { message: 'Corrupt session record', code: 500 } });
      return;
    }

    if (meta.state === 'archived') {
      sendJson(res, 200, { ok: true, id, state: 'archived', message: 'Session was already archived' });
      return;
    }

    const archivedMeta: SessionMeta = {
      ...meta,
      state: 'archived',
      updatedAt: new Date().toISOString(),
    };

    db
      .prepare(`UPDATE chunks SET text = :text WHERE path = :path`)
      .run({ text: JSON.stringify(archivedMeta), path: metaPath });

    log.info({ id, channel: meta.channel, peerId: meta.peerId }, 'Session archived via admin API');
    sendJson(res, 200, { ok: true, id, state: 'archived' });
  } catch (err) {
    log.error({ err, id }, 'DELETE /api/admin/sessions/:id: failed');
    sendJson(res, 500, { error: { message: 'Failed to archive session', code: 500 } });
  } finally {
    db.close();
  }
});
