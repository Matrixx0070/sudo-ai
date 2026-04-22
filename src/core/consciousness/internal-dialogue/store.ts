/**
 * @file store.ts
 * @description Persistence helpers for internal-dialogue debates.
 *
 * All operations use the better-sqlite3 synchronous API.
 * Positions are serialised as a JSON string in the `debates.positions` column
 * and deserialised back to VoicePosition[] on read.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { Debate, VoicePosition } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('internal-dialogue:store');

// ---------------------------------------------------------------------------
// Row shape returned by SQLite
// ---------------------------------------------------------------------------

interface DebateRow {
  id: string;
  question: string;
  context: string;
  positions: string;        // JSON-serialised VoicePosition[]
  resolution: string;
  winning_voice: string;
  confidence: number;
  context_type: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Row converter
// ---------------------------------------------------------------------------

/**
 * Convert a raw SQLite row to a typed Debate object.
 * Parses the JSON positions column, defaulting to an empty array on error.
 */
function rowToDebate(row: DebateRow): Debate {
  let positions: VoicePosition[] = [];

  try {
    const parsed = JSON.parse(row.positions);
    if (Array.isArray(parsed)) {
      positions = parsed as VoicePosition[];
    } else {
      log.warn({ id: row.id }, 'store: positions column is not an array — defaulting to []');
    }
  } catch (err) {
    log.warn(
      { id: row.id, error: err instanceof Error ? err.message : String(err) },
      'store: failed to parse positions JSON — defaulting to []',
    );
  }

  return {
    id: row.id,
    question: row.question,
    context: row.context,
    positions,
    resolution: row.resolution,
    winningVoice: row.winning_voice as Debate['winningVoice'],
    confidence: row.confidence,
    contextType: row.context_type,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// saveDebate
// ---------------------------------------------------------------------------

/**
 * Persist a completed debate to the `debates` table.
 *
 * @param db     - An open better-sqlite3 Database instance.
 * @param debate - The debate to persist.
 * @throws ConsciousnessError on insert failure.
 */
export function saveDebate(db: Database.Database, debate: Debate): void {
  if (!debate || !debate.id) {
    throw new ConsciousnessError(
      'saveDebate: debate object is missing required id field',
      'consciousness_invalid_debate',
      { debate },
    );
  }

  let positionsJson: string;
  try {
    positionsJson = JSON.stringify(debate.positions);
  } catch (err) {
    throw new ConsciousnessError(
      'saveDebate: failed to serialise positions',
      'consciousness_debate_serialise_failed',
      { id: debate.id, error: err instanceof Error ? err.message : String(err) },
    );
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO debates
        (id, question, context, positions, resolution, winning_voice, confidence, context_type, created_at)
      VALUES
        (@id, @question, @context, @positions, @resolution, @winningVoice, @confidence, @contextType, @createdAt)
    `);

    stmt.run({
      id: debate.id,
      question: debate.question,
      context: debate.context,
      positions: positionsJson,
      resolution: debate.resolution,
      winningVoice: debate.winningVoice,
      confidence: debate.confidence,
      contextType: debate.contextType,
      createdAt: debate.createdAt,
    });

    log.debug({ id: debate.id, winningVoice: debate.winningVoice }, 'store: debate saved');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `saveDebate: DB insert failed — ${msg}`,
      'consciousness_debate_insert_failed',
      { id: debate.id, error: msg },
    );
  }
}

// ---------------------------------------------------------------------------
// getDebateHistory
// ---------------------------------------------------------------------------

/**
 * Retrieve the most recent debates from the `debates` table.
 *
 * @param db    - An open better-sqlite3 Database instance.
 * @param limit - Maximum number of rows to return (must be >= 1).
 * @returns Array of Debate objects ordered newest-first.
 * @throws ConsciousnessError on invalid limit or query failure.
 */
export function getDebateHistory(db: Database.Database, limit: number): Debate[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ConsciousnessError(
      'getDebateHistory: limit must be a positive integer',
      'consciousness_invalid_limit',
      { limit },
    );
  }

  try {
    const rows = db
      .prepare(`
        SELECT id, question, context, positions, resolution,
               winning_voice, confidence, context_type, created_at
        FROM debates
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(limit) as DebateRow[];

    log.debug({ count: rows.length, limit }, 'store: debate history fetched');
    return rows.map(rowToDebate);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getDebateHistory: DB query failed — ${msg}`,
      'consciousness_debate_query_failed',
      { limit, error: msg },
    );
  }
}
