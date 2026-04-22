/**
 * @file store-read.ts
 * @description Read / query operations for the episodic memory store.
 *
 * Depends on store-row.ts for the shared EpisodeRow type and rowToEpisode().
 * All operations use prepared statements and throw ConsciousnessError on failure.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { EmotionTag } from '../types.js';
import type { Episode, EpisodeQuery } from './types.js';
import { rowToEpisode, type EpisodeRow } from './store-row.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('episodic-memory:store-read');

// ---------------------------------------------------------------------------
// queryEpisodes
// ---------------------------------------------------------------------------

/**
 * Query episodes using a dynamic filter specification.
 *
 * Supported filters:
 *   - timeRange  → started_at range (>= start, <= end)
 *   - topic      → LIKE partial match on topic
 *   - participant → LIKE partial match on participants JSON text
 *   - emotion    → JSON_EXTRACT dominantEmotion exact match OR LIKE fallback
 *   - outcome    → exact match
 *   - minSignificance → >= threshold
 *
 * @param db    - Active better-sqlite3 Database instance.
 * @param query - Filter and pagination parameters.
 * @returns Matching episodes sorted by started_at DESC.
 */
export function queryEpisodes(db: Database.Database, query: EpisodeQuery): Episode[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (query.timeRange) {
    conditions.push('started_at >= ? AND started_at <= ?');
    params.push(query.timeRange.start, query.timeRange.end);
  }

  if (query.topic) {
    conditions.push('topic LIKE ?');
    params.push(`%${query.topic}%`);
  }

  if (query.participant) {
    conditions.push('participants LIKE ?');
    params.push(`%${query.participant}%`);
  }

  if (query.emotion) {
    conditions.push(
      "(JSON_EXTRACT(emotional_valence, '$.dominantEmotion') = ? OR emotional_valence LIKE ?)",
    );
    params.push(query.emotion, `%${query.emotion}%`);
  }

  if (query.outcome) {
    conditions.push('outcome = ?');
    params.push(query.outcome);
  }

  if (query.minSignificance !== undefined) {
    conditions.push('significance >= ?');
    params.push(query.minSignificance);
  }

  const limit = Math.max(1, query.limit ?? 50);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT * FROM episodes ${where} ORDER BY started_at DESC LIMIT ?`;
  params.push(limit);

  log.debug({ sql, paramCount: params.length }, 'queryEpisodes executing');

  try {
    const rows = db.prepare(sql).all(...params) as EpisodeRow[];
    return rows.map(rowToEpisode);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `queryEpisodes: query failed — ${msg}`,
      'consciousness_episodic_query_failed',
      { cause: msg },
    );
  }
}

// ---------------------------------------------------------------------------
// getRecent
// ---------------------------------------------------------------------------

/**
 * Return the N most recently started episodes.
 *
 * @param db    - Active better-sqlite3 Database instance.
 * @param count - Number of episodes to return (must be >= 1).
 * @throws ConsciousnessError on validation or DB failure.
 */
export function getRecent(db: Database.Database, count: number): Episode[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new ConsciousnessError(
      'getRecent: count must be a positive integer',
      'consciousness_episodic_invalid_input',
      { count },
    );
  }

  const stmt = db.prepare<[number]>(
    'SELECT * FROM episodes ORDER BY started_at DESC LIMIT ?',
  );

  log.debug({ count }, 'getRecent executing');

  try {
    const rows = stmt.all(count) as EpisodeRow[];
    return rows.map(rowToEpisode);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getRecent: query failed — ${msg}`,
      'consciousness_episodic_query_failed',
      { cause: msg },
    );
  }
}

// ---------------------------------------------------------------------------
// getBySignificance
// ---------------------------------------------------------------------------

/**
 * Return the N most significant episodes.
 *
 * @param db    - Active better-sqlite3 Database instance.
 * @param count - Number of episodes to return (must be >= 1).
 * @throws ConsciousnessError on validation or DB failure.
 */
export function getBySignificance(db: Database.Database, count: number): Episode[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new ConsciousnessError(
      'getBySignificance: count must be a positive integer',
      'consciousness_episodic_invalid_input',
      { count },
    );
  }

  const stmt = db.prepare<[number]>(
    'SELECT * FROM episodes ORDER BY significance DESC LIMIT ?',
  );

  log.debug({ count }, 'getBySignificance executing');

  try {
    const rows = stmt.all(count) as EpisodeRow[];
    return rows.map(rowToEpisode);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getBySignificance: query failed — ${msg}`,
      'consciousness_episodic_query_failed',
      { cause: msg },
    );
  }
}

// ---------------------------------------------------------------------------
// getByEmotion
// ---------------------------------------------------------------------------

/**
 * Return episodes where the dominant emotion matches the given tag,
 * sorted by significance DESC.
 *
 * @param db      - Active better-sqlite3 Database instance.
 * @param emotion - Emotion tag to filter by.
 * @param count   - Maximum number of results (must be >= 1).
 * @throws ConsciousnessError on validation or DB failure.
 */
export function getByEmotion(
  db: Database.Database,
  emotion: EmotionTag,
  count: number,
): Episode[] {
  if (!emotion || typeof emotion !== 'string') {
    throw new ConsciousnessError(
      'getByEmotion: emotion tag is required',
      'consciousness_episodic_invalid_input',
      { emotion },
    );
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new ConsciousnessError(
      'getByEmotion: count must be a positive integer',
      'consciousness_episodic_invalid_input',
      { count },
    );
  }

  const stmt = db.prepare<[string, number]>(`
    SELECT * FROM episodes
    WHERE JSON_EXTRACT(emotional_valence, '$.dominantEmotion') = ?
    ORDER BY significance DESC
    LIMIT ?
  `);

  log.debug({ emotion, count }, 'getByEmotion executing');

  try {
    const rows = stmt.all(emotion, count) as EpisodeRow[];
    return rows.map(rowToEpisode);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getByEmotion: query failed — ${msg}`,
      'consciousness_episodic_query_failed',
      { cause: msg },
    );
  }
}
