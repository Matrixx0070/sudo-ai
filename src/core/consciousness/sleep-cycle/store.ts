/**
 * @file store.ts
 * @description SQLite persistence for the sleep-cycle subsystem.
 *
 * All functions operate directly on a better-sqlite3 Database instance so
 * that callers can participate in the same synchronous transaction context
 * as the rest of the consciousness layer.
 *
 * Functions:
 *   saveSleepSession    — INSERT a SleepSession row.
 *   getRecentSessions   — SELECT N most recent sessions by started_at DESC.
 *   getDreamJournal     — SELECT N dream_journal_entry values, newest first.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { SleepSession } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('sleep-cycle:store');

// ---------------------------------------------------------------------------
// Row shape from SQLite
// ---------------------------------------------------------------------------

interface SleepSessionRow {
  id: string;
  episodes_replayed: number;
  patterns_found: number;
  memories_strengthened: number;
  memories_weakened: number;
  insights_generated: number;
  counterfactuals_run: number;
  dream_journal_entry: string;
  duration_ms: number;
  started_at: string;
  ended_at: string | null;
}

// ---------------------------------------------------------------------------
// Row converter
// ---------------------------------------------------------------------------

function rowToSession(row: SleepSessionRow): SleepSession {
  return {
    id: row.id,
    episodesReplayed: row.episodes_replayed,
    patternsFound: row.patterns_found,
    memoriesStrengthened: row.memories_strengthened,
    memoriesWeakened: row.memories_weakened,
    insightsGenerated: row.insights_generated,
    counterfactualsRun: row.counterfactuals_run,
    dreamJournalEntry: row.dream_journal_entry,
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

// ---------------------------------------------------------------------------
// saveSleepSession
// ---------------------------------------------------------------------------

/**
 * Persist a SleepSession record to the sleep_sessions table.
 *
 * @param db      - Open better-sqlite3 Database instance.
 * @param session - The session to persist.
 * @throws ConsciousnessError on DB failure.
 */
export function saveSleepSession(db: Database.Database, session: SleepSession): void {
  if (!session || typeof session.id !== 'string' || session.id.trim() === '') {
    throw new ConsciousnessError(
      'saveSleepSession: session must have a non-empty id',
      'consciousness_sleep_invalid_input',
      { session },
    );
  }

  try {
    db.prepare(`
      INSERT INTO sleep_sessions (
        id,
        episodes_replayed,
        patterns_found,
        memories_strengthened,
        memories_weakened,
        insights_generated,
        counterfactuals_run,
        dream_journal_entry,
        duration_ms,
        started_at,
        ended_at
      ) VALUES (
        @id,
        @episodesReplayed,
        @patternsFound,
        @memoriesStrengthened,
        @memoriesWeakened,
        @insightsGenerated,
        @counterfactualsRun,
        @dreamJournalEntry,
        @durationMs,
        @startedAt,
        @endedAt
      )
    `).run({
      id: session.id,
      episodesReplayed: session.episodesReplayed,
      patternsFound: session.patternsFound,
      memoriesStrengthened: session.memoriesStrengthened,
      memoriesWeakened: session.memoriesWeakened,
      insightsGenerated: session.insightsGenerated,
      counterfactualsRun: session.counterfactualsRun,
      dreamJournalEntry: session.dreamJournalEntry,
      durationMs: session.durationMs,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
    });

    log.info({ id: session.id, durationMs: session.durationMs }, 'Sleep session saved');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `saveSleepSession: DB write failed — ${msg}`,
      'consciousness_sleep_db_error',
      { id: session.id, cause: msg },
    );
  }
}

// ---------------------------------------------------------------------------
// getRecentSessions
// ---------------------------------------------------------------------------

/**
 * Return the N most recent sleep sessions, newest first.
 *
 * @param db    - Open better-sqlite3 Database instance.
 * @param count - Number of records to return (must be >= 1).
 * @returns Array of SleepSession objects (may be empty).
 * @throws ConsciousnessError on invalid input or DB failure.
 */
export function getRecentSessions(db: Database.Database, count: number): SleepSession[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new ConsciousnessError(
      'getRecentSessions: count must be a positive integer',
      'consciousness_sleep_invalid_input',
      { count },
    );
  }

  try {
    const rows = db.prepare(`
      SELECT *
      FROM   sleep_sessions
      ORDER  BY started_at DESC
      LIMIT  ?
    `).all(count) as SleepSessionRow[];

    log.debug({ count, found: rows.length }, 'getRecentSessions complete');
    return rows.map(rowToSession);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getRecentSessions: DB read failed — ${msg}`,
      'consciousness_sleep_db_error',
      { count, cause: msg },
    );
  }
}

// ---------------------------------------------------------------------------
// getDreamJournal
// ---------------------------------------------------------------------------

/**
 * Return the N most recent dream journal entries as plain strings.
 *
 * @param db    - Open better-sqlite3 Database instance.
 * @param count - Number of entries to return (must be >= 1).
 * @returns Array of dream journal strings, newest first.
 * @throws ConsciousnessError on invalid input or DB failure.
 */
export function getDreamJournal(db: Database.Database, count: number): string[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new ConsciousnessError(
      'getDreamJournal: count must be a positive integer',
      'consciousness_sleep_invalid_input',
      { count },
    );
  }

  try {
    const rows = db.prepare(`
      SELECT dream_journal_entry
      FROM   sleep_sessions
      ORDER  BY started_at DESC
      LIMIT  ?
    `).all(count) as Array<{ dream_journal_entry: string }>;

    log.debug({ count, found: rows.length }, 'getDreamJournal complete');
    return rows.map((r) => r.dream_journal_entry);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getDreamJournal: DB read failed — ${msg}`,
      'consciousness_sleep_db_error',
      { count, cause: msg },
    );
  }
}
