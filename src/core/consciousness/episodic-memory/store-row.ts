/**
 * @file store-row.ts
 * @description Shared row type and row→Episode conversion for episodic-memory store.
 *
 * Internal module — not part of the public API. Imported by store-read.ts
 * and store-write.ts to avoid duplication.
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { EmotionalValence } from '../types.js';
import type { Episode } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('episodic-memory:store');

// ---------------------------------------------------------------------------
// EpisodeRow — mirrors the episodes table columns exactly
// ---------------------------------------------------------------------------

export interface EpisodeRow {
  id: string;
  summary: string;
  participants: string;
  topic: string;
  tags: string;
  emotional_valence: string;
  surprise_level: number;
  outcome: string;
  significance: number;
  session_id: string | null;
  started_at: string;
  ended_at: string;
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// rowToEpisode
// ---------------------------------------------------------------------------

/**
 * Convert a raw SQLite row (snake_case) to a typed Episode object (camelCase).
 * JSON columns are parsed with safe fallbacks.
 *
 * @param row - Raw database row.
 * @returns Typed Episode.
 * @throws ConsciousnessError if the emotional_valence JSON column is malformed.
 */
export function rowToEpisode(row: EpisodeRow): Episode {
  let participants: string[] = [];
  let tags: string[] = [];
  let emotionalValence: EmotionalValence;

  try {
    participants = JSON.parse(row.participants) as string[];
  } catch {
    log.warn({ id: row.id }, 'rowToEpisode: failed to parse participants, defaulting to []');
  }

  try {
    tags = JSON.parse(row.tags) as string[];
  } catch {
    log.warn({ id: row.id }, 'rowToEpisode: failed to parse tags, defaulting to []');
  }

  try {
    emotionalValence = JSON.parse(row.emotional_valence) as EmotionalValence;
  } catch {
    throw new ConsciousnessError(
      `rowToEpisode: malformed emotional_valence JSON for episode ${row.id}`,
      'consciousness_episodic_row_parse_failed',
      { id: row.id, raw: row.emotional_valence },
    );
  }

  return {
    id: row.id,
    summary: row.summary,
    participants,
    topic: row.topic,
    tags,
    emotionalValence,
    surpriseLevel: row.surprise_level,
    outcome: row.outcome as Episode['outcome'],
    significance: row.significance,
    sessionId: row.session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
  };
}
