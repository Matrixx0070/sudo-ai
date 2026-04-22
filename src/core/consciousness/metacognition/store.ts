/**
 * @file store.ts
 * @description SQLite persistence for metacognitive reflections.
 *
 * All operations use better-sqlite3 prepared statements (synchronous).
 * Throws ConsciousnessError on validation failure or DB errors.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { Reflection } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('metacognition:store');

// ---------------------------------------------------------------------------
// Row shape (snake_case columns → camelCase interface)
// ---------------------------------------------------------------------------

export interface ReflectionRow {
  id: string;
  subject_episode_id: string;
  question: string;
  analysis: string;
  conclusion: string;
  action_item: string | null;
  quality_score: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Row converter
// ---------------------------------------------------------------------------

/**
 * Map a raw SQLite row to a typed Reflection object.
 *
 * @param row - Raw DB row from the reflections table.
 * @returns Typed Reflection.
 */
export function rowToReflection(row: ReflectionRow): Reflection {
  return {
    id: row.id,
    subjectEpisodeId: row.subject_episode_id,
    question: row.question,
    analysis: row.analysis,
    conclusion: row.conclusion,
    actionItem: row.action_item ?? null,
    qualityScore: row.quality_score,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// saveReflection
// ---------------------------------------------------------------------------

/**
 * Persist a reflection record to the database.
 *
 * @param db - Active better-sqlite3 Database instance.
 * @param r  - Reflection object to save.
 * @throws ConsciousnessError on invalid input or DB failure.
 */
export function saveReflection(db: Database.Database, r: Reflection): void {
  if (!r || typeof r !== 'object') {
    throw new ConsciousnessError(
      'saveReflection: r must be a non-null object',
      'consciousness_meta_invalid_input',
      { received: typeof r },
    );
  }
  if (!r.id || typeof r.id !== 'string') {
    throw new ConsciousnessError(
      'saveReflection: r.id must be a non-empty string',
      'consciousness_meta_invalid_input',
      { id: r.id },
    );
  }
  if (!r.subjectEpisodeId || typeof r.subjectEpisodeId !== 'string') {
    throw new ConsciousnessError(
      'saveReflection: r.subjectEpisodeId must be a non-empty string',
      'consciousness_meta_invalid_input',
      { subjectEpisodeId: r.subjectEpisodeId },
    );
  }
  if (typeof r.qualityScore !== 'number' || r.qualityScore < 0 || r.qualityScore > 1) {
    throw new ConsciousnessError(
      'saveReflection: r.qualityScore must be a number between 0 and 1',
      'consciousness_meta_invalid_input',
      { qualityScore: r.qualityScore },
    );
  }

  const stmt = db.prepare(`
    INSERT INTO reflections (
      id, subject_episode_id, question, analysis,
      conclusion, action_item, quality_score, created_at
    ) VALUES (
      @id, @subject_episode_id, @question, @analysis,
      @conclusion, @action_item, @quality_score, @created_at
    )
  `);

  log.debug({ id: r.id, episodeId: r.subjectEpisodeId }, 'saveReflection executing');

  try {
    stmt.run({
      id: r.id,
      subject_episode_id: r.subjectEpisodeId,
      question: r.question,
      analysis: r.analysis,
      conclusion: r.conclusion,
      action_item: r.actionItem,
      quality_score: r.qualityScore,
      created_at: r.createdAt,
    });
    log.debug({ id: r.id }, 'Reflection saved');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `saveReflection: DB insert failed — ${msg}`,
      'consciousness_meta_db_failed',
      { id: r.id, cause: msg },
    );
  }
}

// ---------------------------------------------------------------------------
// getReflections
// ---------------------------------------------------------------------------

/**
 * Return the N most recently created reflections.
 *
 * @param db    - Active better-sqlite3 Database instance.
 * @param limit - Maximum number of records to return (must be >= 1).
 * @returns Array of reflections ordered by created_at DESC.
 * @throws ConsciousnessError on invalid input or DB failure.
 */
export function getReflections(db: Database.Database, limit: number): Reflection[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ConsciousnessError(
      'getReflections: limit must be a positive integer',
      'consciousness_meta_invalid_input',
      { limit },
    );
  }

  const stmt = db.prepare<[number]>(
    'SELECT * FROM reflections ORDER BY created_at DESC LIMIT ?',
  );

  log.debug({ limit }, 'getReflections executing');

  try {
    const rows = stmt.all(limit) as ReflectionRow[];
    return rows.map(rowToReflection);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getReflections: query failed — ${msg}`,
      'consciousness_meta_db_failed',
      { limit, cause: msg },
    );
  }
}

// ---------------------------------------------------------------------------
// getByEpisode
// ---------------------------------------------------------------------------

/**
 * Return all reflections for a given episode ID.
 *
 * @param db        - Active better-sqlite3 Database instance.
 * @param episodeId - The subject episode ID to filter by.
 * @returns Array of matching reflections (may be empty).
 * @throws ConsciousnessError on invalid input or DB failure.
 */
export function getByEpisode(db: Database.Database, episodeId: string): Reflection[] {
  if (!episodeId || typeof episodeId !== 'string') {
    throw new ConsciousnessError(
      'getByEpisode: episodeId must be a non-empty string',
      'consciousness_meta_invalid_input',
      { episodeId },
    );
  }

  const stmt = db.prepare<[string]>(
    'SELECT * FROM reflections WHERE subject_episode_id = ? ORDER BY created_at DESC',
  );

  log.debug({ episodeId }, 'getByEpisode executing');

  try {
    const rows = stmt.all(episodeId) as ReflectionRow[];
    return rows.map(rowToReflection);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getByEpisode: query failed — ${msg}`,
      'consciousness_meta_db_failed',
      { episodeId, cause: msg },
    );
  }
}
