/**
 * @file detector.ts
 * @description Detects repeated tool-call sequences that are candidates for
 * procedural compilation.
 *
 * Uses the `tool_sequences` table in the consciousness DB.
 * All DB operations use the better-sqlite3 synchronous API.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { ToolCallRecord } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('procedural-memory:detector');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum number of occurrences before a sequence is flagged as a candidate. */
const DEFAULT_MIN_OCCURRENCES = 3;

// ---------------------------------------------------------------------------
// Internal DB row type
// ---------------------------------------------------------------------------

interface ToolSequenceRow {
  sequence: string;
  occurrences: number;
  session_ids: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a tool-call sequence for the given session and check if this exact
 * pattern has now been seen enough times to warrant compilation.
 *
 * @param db        - Open better-sqlite3 Database instance.
 * @param sessionId - Identifier for the originating session.
 * @param toolCalls - Ordered list of tool calls observed in the session.
 * @returns Candidate pattern if this sequence reaches DEFAULT_MIN_OCCURRENCES,
 *          otherwise null.
 */
export function observeSequence(
  db: Database.Database,
  sessionId: string,
  toolCalls: ToolCallRecord[],
): { pattern: string[]; occurrences: number; sessionIds: string[] } | null {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new ConsciousnessError(
      'observeSequence: sessionId must be a non-empty string',
      'consciousness_procedural_invalid_session',
      { sessionId },
    );
  }

  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    log.debug({ sessionId }, 'observeSequence: empty toolCalls — skipping');
    return null;
  }

  // Extract tool names to build the sequence fingerprint.
  const pattern: string[] = toolCalls.map((tc) => {
    if (!tc.toolName || typeof tc.toolName !== 'string') {
      throw new ConsciousnessError(
        'observeSequence: each ToolCallRecord must have a non-empty toolName',
        'consciousness_procedural_invalid_tool_call',
        { toolCall: tc },
      );
    }
    return tc.toolName;
  });

  const sequenceJson = JSON.stringify(pattern);

  log.debug(
    { sessionId, patternLength: pattern.length, fingerprint: pattern.join('|') },
    'observeSequence: recording tool sequence',
  );

  try {
    db.prepare(
      `INSERT INTO tool_sequences (session_id, sequence) VALUES (?, ?)`,
    ).run(sessionId, sequenceJson);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `observeSequence: failed to insert tool sequence: ${msg}`,
      'consciousness_procedural_db_insert_failed',
      { sessionId, sequenceJson, cause: msg },
    );
  }

  // Check current occurrence count for this exact sequence.
  const row = db
    .prepare(
      `SELECT
         sequence,
         COUNT(*)            AS occurrences,
         GROUP_CONCAT(session_id, ',') AS session_ids
       FROM tool_sequences
       WHERE sequence = ?
       GROUP BY sequence`,
    )
    .get(sequenceJson) as
    | { sequence: string; occurrences: number; session_ids: string }
    | undefined;

  if (!row) {
    log.warn({ sequenceJson }, 'observeSequence: count query returned no row after insert');
    return null;
  }

  log.debug(
    { occurrences: row.occurrences, pattern: pattern.join('|') },
    'observeSequence: occurrence count',
  );

  if (row.occurrences >= DEFAULT_MIN_OCCURRENCES) {
    const sessionIds = row.session_ids
      .split(',')
      .filter((s) => s.length > 0);

    log.info(
      { occurrences: row.occurrences, pattern: pattern.join('|'), sessionIds },
      'observeSequence: pattern reached compilation threshold',
    );

    return { pattern, occurrences: row.occurrences, sessionIds };
  }

  return null;
}

/**
 * Scan the `tool_sequences` table and return all patterns that have been
 * observed at least `minOccurrences` times.
 *
 * @param db             - Open better-sqlite3 Database instance.
 * @param minOccurrences - Minimum hit count required (default 3).
 * @returns Patterns sorted by occurrence count descending.
 */
export function findRepeatedPatterns(
  db: Database.Database,
  minOccurrences = DEFAULT_MIN_OCCURRENCES,
): Array<{ pattern: string[]; occurrences: number; sessionIds: string[] }> {
  if (typeof minOccurrences !== 'number' || minOccurrences < 1) {
    throw new ConsciousnessError(
      'findRepeatedPatterns: minOccurrences must be a positive integer',
      'consciousness_procedural_invalid_min_occurrences',
      { minOccurrences },
    );
  }

  log.debug({ minOccurrences }, 'findRepeatedPatterns: scanning for repeated patterns');

  let rows: ToolSequenceRow[];
  try {
    rows = db
      .prepare(
        `SELECT
           sequence,
           COUNT(*)                       AS occurrences,
           GROUP_CONCAT(session_id, ',')  AS session_ids
         FROM tool_sequences
         GROUP BY sequence
         HAVING COUNT(*) >= ?
         ORDER BY occurrences DESC`,
      )
      .all(minOccurrences) as ToolSequenceRow[];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `findRepeatedPatterns: DB query failed: ${msg}`,
      'consciousness_procedural_db_query_failed',
      { minOccurrences, cause: msg },
    );
  }

  const results = rows.map((row) => {
    let pattern: string[];
    try {
      pattern = JSON.parse(row.sequence) as string[];
    } catch {
      log.warn({ sequence: row.sequence }, 'findRepeatedPatterns: malformed sequence JSON — skipping');
      return null;
    }

    const sessionIds = (row.session_ids ?? '')
      .split(',')
      .filter((s) => s.length > 0);

    return { pattern, occurrences: row.occurrences, sessionIds };
  });

  const valid = results.filter(
    (r): r is { pattern: string[]; occurrences: number; sessionIds: string[] } => r !== null,
  );

  log.info(
    { found: valid.length, minOccurrences },
    'findRepeatedPatterns: scan complete',
  );

  return valid;
}
