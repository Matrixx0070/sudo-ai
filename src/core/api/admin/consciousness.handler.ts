/**
 * @file admin/consciousness.handler.ts
 * @description Admin API handlers for the consciousness layer.
 *
 * Routes registered:
 *   GET /api/admin/consciousness/state    — Overall consciousness state summary
 *   GET /api/admin/consciousness/modules  — 20 modules with health checks
 *   GET /api/admin/consciousness/thoughts — Recent thoughts (paginated)
 *   GET /api/admin/consciousness/emotions — Emotional state history (paginated)
 *   GET /api/admin/consciousness/body     — Latest embodied state snapshot
 *   GET /api/admin/consciousness/episodes — Episode history (paginated)
 *
 * DB helpers live in consciousness-helpers.ts.
 * Returns graceful empty/default data when consciousness.db is absent.
 */

import { adminRouter, sendJson } from '../admin-router.js';
import { createLogger } from '../../shared/logger.js';
import {
  openDb,
  closeDb,
  parseIntParam,
  tryParseJson,
  CONSCIOUSNESS_MODULES,
  MODULE_TABLE_MAP,
} from './consciousness-helpers.js';

const log = createLogger('api:admin:consciousness');

// ---------------------------------------------------------------------------
// GET /api/admin/consciousness/state
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/consciousness/state', async (_req, res) => {
  log.debug('GET /api/admin/consciousness/state');

  const db = await openDb();
  if (!db) {
    sendJson(res, 200, {
      online: false, dbExists: false, body: null,
      dominantEmotion: null, activeThoughts: 0,
      totalEpisodes: 0, modules: CONSCIOUSNESS_MODULES.length,
    });
    return;
  }

  try {
    const body = db.prepare(
      `SELECT energy, clarity, fullness, connectivity, continuity, sampled_at
       FROM body_state_log ORDER BY sampled_at DESC LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;

    const emotion = db.prepare(
      `SELECT valence FROM emotional_state_log ORDER BY created_at DESC LIMIT 1`,
    ).get() as { valence: string } | undefined;

    let dominantEmotion: string | null = null;
    if (emotion?.valence) {
      try {
        const p = JSON.parse(emotion.valence) as Record<string, unknown>;
        dominantEmotion = (p['dominantEmotion'] as string) ?? null;
      } catch { /* ignore malformed valence */ }
    }

    // thoughts.created_at is ISO-8601; use strftime, not space-format datetime('now').
    const thoughtRow = db.prepare(
      `SELECT COUNT(*) as cnt FROM thoughts WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')`,
    ).get() as { cnt: number };

    const episodeRow = db.prepare(
      `SELECT COUNT(*) as cnt FROM episodes`,
    ).get() as { cnt: number };

    sendJson(res, 200, {
      online: true, dbExists: true,
      body: body ?? null, dominantEmotion,
      activeThoughts: thoughtRow.cnt,
      totalEpisodes: episodeRow.cnt,
      modules: CONSCIOUSNESS_MODULES.length,
    });
  } catch (err) {
    log.error({ err }, 'consciousness/state query failed');
    sendJson(res, 500, { error: { message: 'DB query failed', code: 500 } });
  } finally {
    closeDb(db);
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/consciousness/modules
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/consciousness/modules', async (_req, res) => {
  log.debug('GET /api/admin/consciousness/modules');

  const db = await openDb();
  const RECENT_WINDOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')";

  const modules = CONSCIOUSNESS_MODULES.map((name) => {
    let healthy = false;
    let rowCount = 0;

    if (db) {
      const table = MODULE_TABLE_MAP[name];
      if (table) {
        try {
          const countRow = db.prepare(
            `SELECT COUNT(*) as cnt FROM ${table}`,
          ).get() as { cnt: number };
          rowCount = countRow.cnt;

          try {
            const recentRow = db.prepare(
              `SELECT COUNT(*) as cnt FROM ${table} WHERE created_at >= ${RECENT_WINDOW}`,
            ).get() as { cnt: number };
            healthy = recentRow.cnt > 0;
          } catch {
            // Some tables use a different timestamp column — fall back to total count.
            healthy = rowCount > 0;
          }
        } catch {
          healthy = false;
        }
      }
    }

    return { name, healthy, rowCount };
  });

  closeDb(db);
  sendJson(res, 200, {
    modules,
    healthy: modules.filter((m) => m.healthy).length,
    total: modules.length,
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/consciousness/thoughts
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/consciousness/thoughts', async (req, res) => {
  log.debug('GET /api/admin/consciousness/thoughts');

  const limit  = parseIntParam(req, 'limit',  50, 1, 200);
  const offset = parseIntParam(req, 'offset',  0, 0, 1_000_000);

  const db = await openDb();
  if (!db) {
    sendJson(res, 200, { thoughts: [], total: 0, limit, offset });
    return;
  }

  try {
    const rows = db.prepare(
      `SELECT id, content, tier, source, activated_concepts,
              emotional_valence, depth, created_at
       FROM thoughts ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(limit, offset) as Array<Record<string, unknown>>;

    const totalRow = db.prepare(
      `SELECT COUNT(*) as cnt FROM thoughts`,
    ).get() as { cnt: number };

    const thoughts = rows.map((r) => ({
      ...r,
      activatedConcepts: tryParseJson(r['activated_concepts'] as string, []),
      emotionalValence:  tryParseJson(r['emotional_valence'] as string, {}),
    }));

    sendJson(res, 200, { thoughts, total: totalRow.cnt, limit, offset });
  } catch (err) {
    log.error({ err }, 'consciousness/thoughts query failed');
    sendJson(res, 500, { error: { message: 'DB query failed', code: 500 } });
  } finally {
    closeDb(db);
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/consciousness/emotions
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/consciousness/emotions', async (req, res) => {
  log.debug('GET /api/admin/consciousness/emotions');

  const limit  = parseIntParam(req, 'limit', 100, 1, 500);
  const offset = parseIntParam(req, 'offset',  0, 0, 1_000_000);

  const db = await openDb();
  if (!db) {
    sendJson(res, 200, { emotions: [], total: 0, limit, offset });
    return;
  }

  try {
    const rows = db.prepare(
      `SELECT id, valence, source, created_at
       FROM emotional_state_log ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(limit, offset) as Array<Record<string, unknown>>;

    const totalRow = db.prepare(
      `SELECT COUNT(*) as cnt FROM emotional_state_log`,
    ).get() as { cnt: number };

    const emotions = rows.map((r) => ({
      ...r,
      valence: tryParseJson(r['valence'] as string, r['valence']),
    }));

    sendJson(res, 200, { emotions, total: totalRow.cnt, limit, offset });
  } catch (err) {
    log.error({ err }, 'consciousness/emotions query failed');
    sendJson(res, 500, { error: { message: 'DB query failed', code: 500 } });
  } finally {
    closeDb(db);
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/consciousness/body
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/consciousness/body', async (_req, res) => {
  log.debug('GET /api/admin/consciousness/body');

  const db = await openDb();
  if (!db) {
    sendJson(res, 200, { body: null });
    return;
  }

  try {
    const row = db.prepare(
      `SELECT id, energy, clarity, fullness, connectivity, continuity,
              raw_metrics, sampled_at
       FROM body_state_log ORDER BY sampled_at DESC LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;

    const body = row
      ? { ...row, rawMetrics: tryParseJson(row['raw_metrics'] as string, {}) }
      : null;

    sendJson(res, 200, { body });
  } catch (err) {
    log.error({ err }, 'consciousness/body query failed');
    sendJson(res, 500, { error: { message: 'DB query failed', code: 500 } });
  } finally {
    closeDb(db);
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/consciousness/episodes
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/consciousness/episodes', async (req, res) => {
  log.debug('GET /api/admin/consciousness/episodes');

  const limit  = parseIntParam(req, 'limit',  50, 1, 200);
  const offset = parseIntParam(req, 'offset',  0, 0, 1_000_000);

  const db = await openDb();
  if (!db) {
    sendJson(res, 200, { episodes: [], total: 0, limit, offset });
    return;
  }

  try {
    const rows = db.prepare(
      `SELECT id, summary, participants, topic, tags, emotional_valence,
              surprise_level, outcome, significance, session_id,
              started_at, ended_at, duration_ms, created_at
       FROM episodes ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    ).all(limit, offset) as Array<Record<string, unknown>>;

    const totalRow = db.prepare(
      `SELECT COUNT(*) as cnt FROM episodes`,
    ).get() as { cnt: number };

    const episodes = rows.map((r) => ({
      ...r,
      participants:     tryParseJson(r['participants'] as string, []),
      tags:             tryParseJson(r['tags'] as string, []),
      emotionalValence: tryParseJson(r['emotional_valence'] as string, {}),
    }));

    sendJson(res, 200, { episodes, total: totalRow.cnt, limit, offset });
  } catch (err) {
    log.error({ err }, 'consciousness/episodes query failed');
    sendJson(res, 500, { error: { message: 'DB query failed', code: 500 } });
  } finally {
    closeDb(db);
  }
});
