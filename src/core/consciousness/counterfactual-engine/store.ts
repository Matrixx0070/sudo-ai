/**
 * @file store.ts
 * @description SQLite persistence for counterfactual simulations.
 *
 * All operations use better-sqlite3 prepared statements (synchronous).
 * Throws ConsciousnessError on validation failure or DB errors.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { Counterfactual } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('counterfactual-engine:store');

// ---------------------------------------------------------------------------
// Row shape (snake_case columns → camelCase interface)
// ---------------------------------------------------------------------------

export interface CounterfactualRow {
  id: string;
  original_episode_id: string;
  alternative_action: string;
  simulated_outcome: string;
  actual_outcome: string;
  delta_assessment: string;
  lesson_learned: string | null;
  confidence: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Row converter
// ---------------------------------------------------------------------------

/**
 * Map a raw SQLite row to a typed Counterfactual object.
 *
 * @param row - Raw DB row from the counterfactuals table.
 * @returns Typed Counterfactual.
 */
export function rowToCounterfactual(row: CounterfactualRow): Counterfactual {
  return {
    id: row.id,
    originalEpisodeId: row.original_episode_id,
    alternativeAction: row.alternative_action,
    simulatedOutcome: row.simulated_outcome,
    actualOutcome: row.actual_outcome,
    deltaAssessment: row.delta_assessment,
    lessonLearned: row.lesson_learned ?? null,
    confidence: row.confidence,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// saveCounterfactual
// ---------------------------------------------------------------------------

/**
 * Persist a counterfactual record to the database.
 *
 * @param db - Active better-sqlite3 Database instance.
 * @param cf - Counterfactual object to save.
 * @throws ConsciousnessError on invalid input or DB failure.
 */
export function saveCounterfactual(db: Database.Database, cf: Counterfactual): void {
  if (!cf || typeof cf !== 'object') {
    throw new ConsciousnessError(
      'saveCounterfactual: cf must be a non-null object',
      'consciousness_cf_invalid_input',
      { received: typeof cf },
    );
  }
  if (!cf.id || typeof cf.id !== 'string') {
    throw new ConsciousnessError(
      'saveCounterfactual: cf.id must be a non-empty string',
      'consciousness_cf_invalid_input',
      { id: cf.id },
    );
  }
  if (!cf.originalEpisodeId || typeof cf.originalEpisodeId !== 'string') {
    throw new ConsciousnessError(
      'saveCounterfactual: cf.originalEpisodeId must be a non-empty string',
      'consciousness_cf_invalid_input',
      { originalEpisodeId: cf.originalEpisodeId },
    );
  }
  if (typeof cf.confidence !== 'number' || cf.confidence < 0 || cf.confidence > 1) {
    throw new ConsciousnessError(
      'saveCounterfactual: cf.confidence must be a number between 0 and 1',
      'consciousness_cf_invalid_input',
      { confidence: cf.confidence },
    );
  }

  const stmt = db.prepare(`
    INSERT INTO counterfactuals (
      id, original_episode_id, alternative_action, simulated_outcome,
      actual_outcome, delta_assessment, lesson_learned, confidence, created_at
    ) VALUES (
      @id, @original_episode_id, @alternative_action, @simulated_outcome,
      @actual_outcome, @delta_assessment, @lesson_learned, @confidence, @created_at
    )
  `);

  log.debug({ id: cf.id, episodeId: cf.originalEpisodeId }, 'saveCounterfactual executing');

  try {
    stmt.run({
      id: cf.id,
      original_episode_id: cf.originalEpisodeId,
      alternative_action: cf.alternativeAction,
      simulated_outcome: cf.simulatedOutcome,
      actual_outcome: cf.actualOutcome,
      delta_assessment: cf.deltaAssessment,
      lesson_learned: cf.lessonLearned,
      confidence: cf.confidence,
      created_at: cf.createdAt,
    });
    log.debug({ id: cf.id }, 'Counterfactual saved');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `saveCounterfactual: DB insert failed — ${msg}`,
      'consciousness_cf_db_failed',
      { id: cf.id, cause: msg },
    );
  }
}

// ---------------------------------------------------------------------------
// getByEpisode
// ---------------------------------------------------------------------------

/**
 * Return all counterfactuals for a given episode ID.
 *
 * @param db        - Active better-sqlite3 Database instance.
 * @param episodeId - The original episode ID to filter by.
 * @returns Array of matching counterfactuals (may be empty).
 * @throws ConsciousnessError on invalid input or DB failure.
 */
export function getByEpisode(db: Database.Database, episodeId: string): Counterfactual[] {
  if (!episodeId || typeof episodeId !== 'string') {
    throw new ConsciousnessError(
      'getByEpisode: episodeId must be a non-empty string',
      'consciousness_cf_invalid_input',
      { episodeId },
    );
  }

  const stmt = db.prepare<[string]>(
    'SELECT * FROM counterfactuals WHERE original_episode_id = ? ORDER BY created_at DESC',
  );

  log.debug({ episodeId }, 'getByEpisode executing');

  try {
    const rows = stmt.all(episodeId) as CounterfactualRow[];
    return rows.map(rowToCounterfactual);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getByEpisode: query failed — ${msg}`,
      'consciousness_cf_db_failed',
      { episodeId, cause: msg },
    );
  }
}

// ---------------------------------------------------------------------------
// getRecent
// ---------------------------------------------------------------------------

/**
 * Return the N most recently created counterfactuals.
 *
 * @param db    - Active better-sqlite3 Database instance.
 * @param count - Number of records to return (must be >= 1).
 * @returns Array of counterfactuals ordered by created_at DESC.
 * @throws ConsciousnessError on invalid input or DB failure.
 */
export function getRecent(db: Database.Database, count: number): Counterfactual[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new ConsciousnessError(
      'getRecent: count must be a positive integer',
      'consciousness_cf_invalid_input',
      { count },
    );
  }

  const stmt = db.prepare<[number]>(
    'SELECT * FROM counterfactuals ORDER BY created_at DESC LIMIT ?',
  );

  log.debug({ count }, 'getRecent executing');

  try {
    const rows = stmt.all(count) as CounterfactualRow[];
    return rows.map(rowToCounterfactual);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getRecent: query failed — ${msg}`,
      'consciousness_cf_db_failed',
      { count, cause: msg },
    );
  }
}
