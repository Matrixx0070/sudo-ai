/**
 * @file retrieval.ts
 * @description Full-text search over episodic memory using SQLite LIKE.
 *
 * Results are sorted by significance DESC so the most important matching
 * episodes surface first.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { Episode } from './types.js';
import { rowToEpisode, type EpisodeRow } from './store-row.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('episodic-memory:retrieval');

// ---------------------------------------------------------------------------
// searchEpisodes
// ---------------------------------------------------------------------------

const DEFAULT_SEARCH_LIMIT = 20;

/**
 * Search episodes by matching `text` against the summary and topic columns.
 *
 * Both columns are checked with SQL LIKE, and results are returned ordered
 * by significance DESC so the most important matches appear first.
 *
 * @param db    - Active better-sqlite3 Database instance.
 * @param text  - Search string (must be non-empty).
 * @param limit - Maximum results to return (default 20, minimum 1).
 * @returns Matching episodes sorted by significance DESC.
 * @throws ConsciousnessError on invalid input or DB error.
 */
export function searchEpisodes(
  db: Database.Database,
  text: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
): Episode[] {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new ConsciousnessError(
      'searchEpisodes: search text must be a non-empty string',
      'consciousness_episodic_invalid_input',
      { text },
    );
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ConsciousnessError(
      'searchEpisodes: limit must be a positive integer',
      'consciousness_episodic_invalid_input',
      { limit },
    );
  }

  const pattern = `%${text.trim()}%`;

  const stmt = db.prepare<[string, string, number]>(`
    SELECT * FROM episodes
    WHERE summary LIKE ? OR topic LIKE ?
    ORDER BY significance DESC
    LIMIT ?
  `);

  log.debug({ text, limit }, 'searchEpisodes executing');

  try {
    const rows = stmt.all(pattern, pattern, limit) as EpisodeRow[];
    const episodes = rows.map(rowToEpisode);
    log.debug({ text, found: episodes.length }, 'searchEpisodes complete');
    return episodes;
  } catch (err: unknown) {
    if (err instanceof ConsciousnessError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `searchEpisodes: query failed — ${msg}`,
      'consciousness_episodic_query_failed',
      { cause: msg },
    );
  }
}
