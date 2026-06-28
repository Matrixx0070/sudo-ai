/**
 * @file store-write.ts
 * @description Write operations (INSERT / UPDATE) for the episodic memory store.
 *
 * Depends on store-row.ts for the shared EpisodeRow type.
 * All operations use prepared statements and throw ConsciousnessError on failure.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { Episode } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('episodic-memory:store-write');

// ---------------------------------------------------------------------------
// saveEpisode
// ---------------------------------------------------------------------------

/**
 * Persist a new episode to the database.
 *
 * @param db      - Active better-sqlite3 Database instance.
 * @param episode - Episode to insert (id, summary, startedAt, endedAt required).
 * @throws ConsciousnessError on validation or DB failure.
 */
export function saveEpisode(db: Database.Database, episode: Episode): void {
  if (!episode.id || typeof episode.id !== 'string') {
    throw new ConsciousnessError(
      'saveEpisode: episode.id is required',
      'consciousness_episodic_invalid_input',
      { received: typeof episode.id },
    );
  }
  if (!episode.summary || episode.summary.trim().length === 0) {
    throw new ConsciousnessError(
      'saveEpisode: episode.summary is required',
      'consciousness_episodic_invalid_input',
      { id: episode.id },
    );
  }
  if (!episode.startedAt || !episode.endedAt) {
    throw new ConsciousnessError(
      'saveEpisode: episode.startedAt and endedAt are required',
      'consciousness_episodic_invalid_input',
      { id: episode.id },
    );
  }

  // Coerce every remaining bound field to a value SQLite can bind (never
  // undefined — better-sqlite3 throws on undefined, and JSON.stringify(undefined)
  // returns the JS value `undefined`, not a string). Defaults mirror the schema
  // column defaults and respect its CHECK constraints (surprise_level/significance
  // in [0,1]; outcome in the enum), so a partially-constructed Episode (common on
  // crash recovery / stream-parse) persists instead of throwing an opaque bind error.
  const VALID_OUTCOMES = new Set(['positive', 'negative', 'neutral', 'mixed']);
  const clamp01 = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : NaN);

  const participantsJson = JSON.stringify(Array.isArray(episode.participants) ? episode.participants : []);
  const topicStr = typeof episode.topic === 'string' ? episode.topic : '';
  const tagsJson = JSON.stringify(Array.isArray(episode.tags) ? episode.tags : []);
  const valenceJson = JSON.stringify(episode.emotionalValence ?? {});
  const surpriseLevel = Number.isNaN(clamp01(episode.surpriseLevel)) ? 0 : clamp01(episode.surpriseLevel);
  const outcomeStr = typeof episode.outcome === 'string' && VALID_OUTCOMES.has(episode.outcome) ? episode.outcome : 'neutral';
  const significance = Number.isNaN(clamp01(episode.significance)) ? 0.5 : clamp01(episode.significance);
  const sessionId = typeof episode.sessionId === 'string' ? episode.sessionId : null;
  const durationMs = typeof episode.durationMs === 'number' && Number.isFinite(episode.durationMs) && episode.durationMs >= 0
    ? Math.floor(episode.durationMs)
    : 0;

  // Idempotent upsert: a crash-then-recover or at-least-once recorder re-inserts
  // the same id — a plain INSERT throws SQLITE_CONSTRAINT_PRIMARYKEY, which the
  // caller cannot distinguish from real corruption. ON CONFLICT makes retry safe.
  const stmt = db.prepare<[
    string, string, string, string, string, string,
    number, string, number, string | null, string, string, number,
  ]>(`
    INSERT INTO episodes
      (id, summary, participants, topic, tags, emotional_valence,
       surprise_level, outcome, significance, session_id,
       started_at, ended_at, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      summary=excluded.summary,
      significance=MAX(episodes.significance, excluded.significance),
      ended_at=excluded.ended_at,
      duration_ms=excluded.duration_ms
  `);

  try {
    stmt.run(
      episode.id,
      episode.summary,
      participantsJson,
      topicStr,
      tagsJson,
      valenceJson,
      surpriseLevel,
      outcomeStr,
      significance,
      sessionId,
      episode.startedAt,
      episode.endedAt,
      durationMs,
    );
    log.debug({ id: episode.id, topic: topicStr }, 'Episode saved');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `saveEpisode: DB insert failed — ${msg}`,
      'consciousness_episodic_save_failed',
      { id: episode.id, cause: msg },
    );
  }
}

// ---------------------------------------------------------------------------
// strengthenEpisode
// ---------------------------------------------------------------------------

/**
 * Increase the significance of an episode by delta, capped at 1.0.
 *
 * @param db    - Active better-sqlite3 Database instance.
 * @param id    - Episode ID.
 * @param delta - Positive amount to add.
 * @throws ConsciousnessError on validation or DB failure.
 */
export function strengthenEpisode(
  db: Database.Database,
  id: string,
  delta: number,
): void {
  if (!id || typeof id !== 'string') {
    throw new ConsciousnessError(
      'strengthenEpisode: id is required',
      'consciousness_episodic_invalid_input',
      { id },
    );
  }
  if (typeof delta !== 'number' || delta <= 0) {
    throw new ConsciousnessError(
      'strengthenEpisode: delta must be a positive number',
      'consciousness_episodic_invalid_input',
      { id, delta },
    );
  }

  const stmt = db.prepare<[number, string]>(`
    UPDATE episodes
    SET significance = MIN(significance + ?, 1.0)
    WHERE id = ?
  `);

  try {
    const result = stmt.run(delta, id);
    if (result.changes === 0) {
      log.warn({ id }, 'strengthenEpisode: no episode found with that id');
    } else {
      log.debug({ id, delta }, 'Episode strengthened');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `strengthenEpisode: update failed — ${msg}`,
      'consciousness_episodic_update_failed',
      { id, cause: msg },
    );
  }
}

// ---------------------------------------------------------------------------
// weakenEpisode
// ---------------------------------------------------------------------------

/**
 * Decrease the significance of an episode by delta, floored at 0.
 *
 * @param db    - Active better-sqlite3 Database instance.
 * @param id    - Episode ID.
 * @param delta - Positive amount to subtract.
 * @throws ConsciousnessError on validation or DB failure.
 */
export function weakenEpisode(
  db: Database.Database,
  id: string,
  delta: number,
): void {
  if (!id || typeof id !== 'string') {
    throw new ConsciousnessError(
      'weakenEpisode: id is required',
      'consciousness_episodic_invalid_input',
      { id },
    );
  }
  if (typeof delta !== 'number' || delta <= 0) {
    throw new ConsciousnessError(
      'weakenEpisode: delta must be a positive number',
      'consciousness_episodic_invalid_input',
      { id, delta },
    );
  }

  const stmt = db.prepare<[number, string]>(`
    UPDATE episodes
    SET significance = MAX(significance - ?, 0)
    WHERE id = ?
  `);

  try {
    const result = stmt.run(delta, id);
    if (result.changes === 0) {
      log.warn({ id }, 'weakenEpisode: no episode found with that id');
    } else {
      log.debug({ id, delta }, 'Episode weakened');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `weakenEpisode: update failed — ${msg}`,
      'consciousness_episodic_update_failed',
      { id, cause: msg },
    );
  }
}
