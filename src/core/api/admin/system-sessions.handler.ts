/**
 * @file admin/system-sessions.handler.ts
 * @description BO9 / scorecard-S8 — admin API for the sessions table rendered by
 * the inline admin dashboard.
 *
 * Routes (served canonically under /v1/admin/system/*):
 *   GET  /api/admin/system/sessions?state=&sort=&groupBy=&window=
 *   POST /api/admin/system/sessions/archive   { id, confirm }
 *   POST /api/admin/system/sessions/fork      { id }
 *
 * The GET is READ-ONLY over mind.db (`readonly: true`, SELECTs only) — it hands
 * meta + per-session usage to the PURE roll-up (`sessions/sessions-rollup.ts`)
 * that computes context-fill %, sorting, and kind grouping.
 *
 * The two POSTs beat two OpenClaw behaviours:
 *   - ARCHIVE requires an explicit confirm (OpenClaw archives with no confirm —
 *     one of their 8 defects). `planArchive` rejects an unconfirmed call before
 *     any write; archive is a reversible state mark, never a hard delete.
 *   - FORK copies history into a NEW session (additive) via the real MindDB
 *     memory API (storeSession/storeChunk/storeMessage — invariant 5). The source
 *     session is never mutated.
 *
 * S15/S16 untouched: reads are read-only; the only writes are a reversible meta
 * state flip and an additive fork that never deletes or rewrites source data.
 */

import { adminRouter, sendJson, readJsonBody } from '../admin-router.js';
import { createLogger } from '../../shared/logger.js';
import { genId } from '../../shared/index.js';
import type { MindDB } from '../../memory/db.js';
import {
  openMindDb,
  loadAllSessionMetas,
  loadSessionUsage,
  loadSessionMeta,
  loadSessionMessages,
  updateSessionState,
  MIND_DB_PATH,
  type SessionMeta,
} from './sessions.db-utils.js';
import {
  buildSessionRows,
  type SessionUsageRecord,
  type SessionSort,
  type SessionGroupBy,
} from '../../sessions/sessions-rollup.js';
import {
  planArchive,
  buildForkedSession,
  type ForkableMessage,
} from '../../sessions/session-admin-actions.js';

const log = createLogger('api:admin:system-sessions');

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

function parseSort(v: string | null): SessionSort {
  return v === 'tokens' || v === 'messages' || v === 'key' ? v : 'updated';
}
function parseGroupBy(v: string | null): SessionGroupBy {
  return v === 'kind' ? 'kind' : 'none';
}
function parseState(v: string | null): 'active' | 'compacted' | 'archived' | 'all' {
  return v === 'compacted' || v === 'archived' || v === 'all' ? v : 'active';
}
function parseWindow(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 1000 ? n : undefined;
}

async function parseBody(req: Parameters<typeof readJsonBody>[0]): Promise<Record<string, unknown> | null> {
  try {
    const body = await readJsonBody(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/system/sessions
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/system/sessions', async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const sort = parseSort(url.searchParams.get('sort'));
  const groupBy = parseGroupBy(url.searchParams.get('groupBy'));
  const stateFilter = parseState(url.searchParams.get('state'));
  const contextWindow = parseWindow(url.searchParams.get('window'));
  log.debug({ sort, groupBy, stateFilter }, 'GET system/sessions');

  const db = await openMindDb({ readonly: true });
  if (!db) {
    sendJson(res, 200, { ok: true, data: buildSessionRows([], { sort, groupBy, stateFilter, contextWindow }) });
    return;
  }
  try {
    const metas = loadAllSessionMetas(db);
    const usage = loadSessionUsage(db);
    const records: SessionUsageRecord[] = metas.map((m) => {
      const u = usage.get(m.id);
      return {
        id: m.id,
        kind: m.channel,
        peerId: m.peerId,
        state: m.state,
        model: m.model ?? null,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        chars: u?.chars ?? 0,
        messageCount: u?.messageCount ?? 0,
      };
    });
    const rollup = buildSessionRows(records, { sort, groupBy, stateFilter, contextWindow });
    sendJson(res, 200, { ok: true, data: rollup });
  } catch (err) {
    log.warn({ err: String(err) }, 'GET system/sessions failed');
    sendJson(res, 200, { ok: false, error: 'sessions unavailable' });
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/system/sessions/archive   { id, confirm }
// ---------------------------------------------------------------------------

adminRouter.post('/api/admin/system/sessions/archive', async (req, res) => {
  const body = await parseBody(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: { message: 'Request body must be a JSON object', code: 400 } });
    return;
  }
  const id = typeof body['id'] === 'string' ? body['id'].trim() : '';
  const confirm = body['confirm'] as boolean | string | undefined;
  if (!id) {
    sendJson(res, 400, { ok: false, error: { message: 'id is required', code: 400 } });
    return;
  }

  const db = await openMindDb({ readonly: false });
  if (!db) {
    sendJson(res, 404, { ok: false, error: { message: 'Session store unavailable', code: 404 } });
    return;
  }
  try {
    const meta = loadSessionMeta(db, id);
    const plan = planArchive({ id, confirm }, meta ? { state: meta.state } : null);
    if (!plan.ok) {
      // confirm_required -> 400 (the beat-OpenClaw gate); not_found -> 404;
      // already_archived -> 200 idempotent.
      if (plan.code === 'already_archived') {
        sendJson(res, 200, { ok: true, id, state: 'archived', message: plan.message });
      } else {
        const code = plan.code === 'not_found' ? 404 : 400;
        sendJson(res, code, { ok: false, code: plan.code, error: { message: plan.message, code } });
      }
      return;
    }
    updateSessionState(db, id, meta as SessionMeta, 'archived');
    log.info({ id }, 'Session archived via admin (confirmed)');
    sendJson(res, 200, { ok: true, id, state: 'archived' });
  } catch (err) {
    log.warn({ err: String(err), id }, 'archive failed');
    sendJson(res, 500, { ok: false, error: { message: 'Failed to archive session', code: 500 } });
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/system/sessions/fork   { id }
// ---------------------------------------------------------------------------

adminRouter.post('/api/admin/system/sessions/fork', async (req, res) => {
  const body = await parseBody(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: { message: 'Request body must be a JSON object', code: 400 } });
    return;
  }
  const id = typeof body['id'] === 'string' ? body['id'].trim() : '';
  if (!id) {
    sendJson(res, 400, { ok: false, error: { message: 'id is required', code: 400 } });
    return;
  }

  // Read the source read-only first (never mutate it).
  const rdb = await openMindDb({ readonly: true });
  if (!rdb) {
    sendJson(res, 404, { ok: false, error: { message: 'Session store unavailable', code: 404 } });
    return;
  }
  let meta: SessionMeta | null;
  let messages: ForkableMessage[];
  try {
    meta = loadSessionMeta(rdb, id);
    if (!meta) {
      sendJson(res, 404, { ok: false, error: { message: `Session not found: ${id}`, code: 404 } });
      return;
    }
    messages = loadSessionMessages(rdb, id).map((m) => ({
      role: (['user', 'assistant', 'system', 'tool'].includes(m.role) ? m.role : 'user') as ForkableMessage['role'],
      content: m.content ?? '',
      ...(m.tool_name ? { toolName: m.tool_name } : {}),
    }));
  } finally {
    rdb.close();
  }

  // Build the additive fork spec (pure) — source object is untouched.
  const newId = genId();
  const forked = buildForkedSession(
    {
      id: meta.id,
      channel: meta.channel,
      peerId: meta.peerId,
      state: meta.state,
      ...(meta.model ? { model: meta.model } : {}),
      messages,
      createdAt: new Date(meta.createdAt),
      updatedAt: new Date(meta.updatedAt),
    },
    { newId },
  );

  // Write the copy through the real MindDB memory API (invariant 5): session row
  // + meta chunk (hash-addressed) + each copied message (msg-scan applied).
  let mind: MindDB | null = null;
  try {
    const mod = await import('../../memory/db.js');
    mind = new mod.MindDB(MIND_DB_PATH);
    mind.storeSession({ id: forked.id, model: forked.model ?? 'unknown', title: `${forked.channel}:${forked.peerId}` });
    const metaJson = JSON.stringify({
      id: forked.id,
      channel: forked.channel,
      peerId: forked.peerId,
      state: forked.state,
      model: forked.model,
      createdAt: forked.createdAt.toISOString(),
      updatedAt: forked.updatedAt.toISOString(),
    });
    mind.storeChunk(metaJson, `session:${forked.id}:meta`, 'conversation', { isEvergreen: true, role: 'system' });
    let copied = 0;
    for (const m of forked.messages) {
      try {
        mind.storeMessage(forked.id, m.role, m.content ?? '', m.toolName ? { tool_name: m.toolName } : {});
        copied += 1;
      } catch (e) {
        log.warn({ err: String(e), newId: forked.id }, 'fork: message copy skipped');
      }
    }
    log.info({ from: id, to: forked.id, copied }, 'Session forked (additive copy) via admin');
    sendJson(res, 200, {
      ok: true,
      id: forked.id,
      forkedFrom: id,
      peerId: forked.peerId,
      messagesCopied: copied,
    });
  } catch (err) {
    log.warn({ err: String(err), id }, 'fork failed');
    sendJson(res, 500, { ok: false, error: { message: 'Failed to fork session', code: 500 } });
  } finally {
    try { mind?.close(); } catch { /* ignore */ }
  }
});
