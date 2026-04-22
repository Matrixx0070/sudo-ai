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

  const stmt = db.prepare<[
    string, string, string, string, string, string,
    number, string, number, string | null, string, string, number,
  ]>(`
    INSERT INTO episodes
      (id, summary, participants, topic, tags, emotional_valence,
       surprise_level, outcome, significance, session_id,
       started_at, ended_at, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    stmt.run(
      episode.id,
      episode.summary,
      JSON.stringify(episode.participants),
      episode.topic,
      JSON.stringify(episode.tags),
      JSON.stringify(episode.emotionalValence),
      episode.surpriseLevel,
      episode.outcome,
      episode.significance,
      episode.sessionId,
      episode.startedAt,
      episode.endedAt,
      episode.durationMs,
    );
    log.debug({ id: episode.id, topic: episode.topic }, 'Episode saved');
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
