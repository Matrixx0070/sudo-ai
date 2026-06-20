/**
 * @file store.ts
 * @description SQLite persistence helpers for the surprise-engine module.
 *
 * All functions are pure with respect to side effects: they accept an open
 * Database instance and perform a single synchronous operation.
 * No module-level state — safe to call from any context.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { SurpriseEvent } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('surprise-engine:store');

// ---------------------------------------------------------------------------
// Row shape returned by better-sqlite3
// ---------------------------------------------------------------------------

interface SurpriseRow {
  id: string;
  prediction_id: string;
  magnitude: number;
  direction: string;
  description: string;
  triggered_actions: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Row converter
// ---------------------------------------------------------------------------

/**
 * Convert a raw SQLite row to a typed SurpriseEvent.
 * Throws ConsciousnessError on malformed direction or JSON.
 */
function rowToEvent(row: SurpriseRow): SurpriseEvent {
  const direction = row.direction as SurpriseEvent['direction'];
  if (direction !== 'better' && direction !== 'worse' && direction !== 'different') {
    throw new ConsciousnessError(
      `Invalid surprise direction in DB row: ${row.direction}`,
      'consciousness_surprise_invalid_row',
      { id: row.id, direction: row.direction },
    );
  }

  let triggeredActions: string[];
  try {
    triggeredActions = JSON.parse(row.triggered_actions) as string[];
  } catch {
    log.warn({ id: row.id }, 'Malformed triggered_actions JSON — defaulting to []');
    triggeredActions = [];
  }

  return {
    id: row.id,
    predictionId: row.prediction_id,
    magnitude: row.magnitude,
    direction,
    description: row.description,
    triggeredActions,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Public store functions
// ---------------------------------------------------------------------------

/**
 * Persist a SurpriseEvent to the surprise_events table.
 *
 * @param db    - Open better-sqlite3 Database instance.
 * @param event - The event to insert.
 * @throws ConsciousnessError on DB write failure.
 */
export function saveSurpriseEvent(db: Database.Database, event: SurpriseEvent): void {
  const stmt = db.prepare<[string, string, number, string, string, string, string]>(
    `INSERT INTO surprise_events
       (id, prediction_id, magnitude, direction, description, triggered_actions, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  try {
    stmt.run(
      event.id,
      event.predictionId,
      event.magnitude,
      event.direction,
      event.description,
      JSON.stringify(event.triggeredActions),
      event.createdAt,
    );
    log.debug({ id: event.id, magnitude: event.magnitude }, 'SurpriseEvent saved');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `Failed to save surprise event: ${msg}`,
      'consciousness_surprise_save_failed',
      { id: event.id, cause: msg },
    );
  }
}

/**
 * Retrieve the most recent surprise events ordered by creation time descending.
 *
 * @param db    - Open better-sqlite3 Database instance.
 * @param count - Maximum number of events to return.
 * @returns Array of SurpriseEvent (may be empty).
 * @throws ConsciousnessError on DB read failure.
 */
export function getRecentSurprises(db: Database.Database, count: number): SurpriseEvent[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new ConsciousnessError(
      `getRecentSurprises: count must be a positive integer, got ${count}`,
      'consciousness_surprise_invalid_count',
      { count },
    );
  }

  try {
    const rows = db
      .prepare<[number], SurpriseRow>(
        `SELECT id, prediction_id, magnitude, direction, description,
                triggered_actions, created_at
         FROM surprise_events
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(count);

    return rows.map(rowToEvent);
  } catch (err: unknown) {
    if (err instanceof ConsciousnessError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `Failed to fetch recent surprises: ${msg}`,
      'consciousness_surprise_fetch_failed',
      { count, cause: msg },
    );
  }
}

/**
 * Compute the average surprise magnitude over a rolling time window.
 *
 * @param db    - Open better-sqlite3 Database instance.
 * @param hours - Look-back window in hours (must be > 0).
 * @returns Average magnitude 0..1, or 0 when no events exist in the window.
 * @throws ConsciousnessError on invalid arguments or DB failure.
 */
export function getAverageSurprise(db: Database.Database, hours: number): number {
  if (typeof hours !== 'number' || hours <= 0 || !isFinite(hours)) {
    throw new ConsciousnessError(
      `getAverageSurprise: hours must be a positive finite number, got ${hours}`,
      'consciousness_surprise_invalid_hours',
      { hours },
    );
  }

  try {
    // surprise_events.created_at is ISO-8601; use strftime, not datetime('now').
    const row = db
      .prepare<[string], { avg: number | null }>(
        `SELECT AVG(magnitude) AS avg
         FROM surprise_events
         WHERE created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now',?)`,
      )
      .get(`-${hours} hours`);

    const avg = row?.avg ?? 0;
    log.debug({ hours, avg }, 'Average surprise computed');
    return avg;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `Failed to compute average surprise: ${msg}`,
      'consciousness_surprise_avg_failed',
      { hours, cause: msg },
    );
  }
}
