/**
 * @file store.ts
 * @description DB access layer for the relationship-model subsystem.
 * Table: relationships (see consciousness-db.ts).
 * Synchronous better-sqlite3 API throughout — no async/await.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { Relationship } from './types.js';

const log = createLogger('relationship-model:store');

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

interface RelationshipRow {
  user_id: string;
  stage: string;
  trust_trajectory: string;
  shared_references: string;
  communication_evolution: string;
  inside_jokes: string;
  conflict_history: string;
  total_interactions: number;
  first_interaction: string;
  last_interaction: string;
}

// ---------------------------------------------------------------------------
// Row converter
// ---------------------------------------------------------------------------

function rowToRelationship(row: RelationshipRow): Relationship {
  return {
    userId: row.user_id,
    stage: row.stage as Relationship['stage'],
    trustTrajectory: row.trust_trajectory as Relationship['trustTrajectory'],
    sharedReferences: JSON.parse(row.shared_references) as string[],
    communicationEvolution: row.communication_evolution,
    insideJokes: JSON.parse(row.inside_jokes) as string[],
    conflictHistory: JSON.parse(row.conflict_history) as string[],
    totalInteractions: row.total_interactions,
    firstInteraction: row.first_interaction,
    lastInteraction: row.last_interaction,
  };
}

// ---------------------------------------------------------------------------
// Relationship CRUD
// ---------------------------------------------------------------------------

/**
 * Insert or replace the full relationship record for a user.
 * All array fields are JSON-serialized.
 * @throws ConsciousnessError on invalid input or DB write failure.
 */
export function saveRelationship(db: Database.Database, rel: Relationship): void {
  if (!rel.userId || typeof rel.userId !== 'string') {
    throw new ConsciousnessError(
      'saveRelationship: rel.userId must be a non-empty string',
      'consciousness_relationship_model_invalid_user',
      { userId: rel.userId },
    );
  }
  try {
    db.prepare(
      `INSERT OR REPLACE INTO relationships
         (user_id, stage, trust_trajectory, shared_references,
          communication_evolution, inside_jokes, conflict_history,
          total_interactions, first_interaction, last_interaction, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rel.userId,
      rel.stage,
      rel.trustTrajectory,
      JSON.stringify(rel.sharedReferences),
      rel.communicationEvolution,
      JSON.stringify(rel.insideJokes),
      JSON.stringify(rel.conflictHistory),
      rel.totalInteractions,
      rel.firstInteraction,
      rel.lastInteraction,
      new Date().toISOString(),
    );
    log.debug({ userId: rel.userId, stage: rel.stage }, 'Relationship saved');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `saveRelationship DB error: ${msg}`,
      'consciousness_relationship_model_db_write',
      { userId: rel.userId, cause: msg },
    );
  }
}

/**
 * Retrieve the relationship record for a user, or null if not found.
 * @throws ConsciousnessError on DB read failure.
 */
export function getRelationship(db: Database.Database, userId: string): Relationship | null {
  if (!userId || typeof userId !== 'string') {
    throw new ConsciousnessError(
      'getRelationship: userId must be a non-empty string',
      'consciousness_relationship_model_invalid_user',
      { userId },
    );
  }
  try {
    const row = db
      .prepare('SELECT * FROM relationships WHERE user_id = ?')
      .get(userId) as RelationshipRow | undefined;
    if (!row) {
      log.debug({ userId }, 'Relationship not found');
      return null;
    }
    return rowToRelationship(row);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getRelationship DB error: ${msg}`,
      'consciousness_relationship_model_db_read',
      { userId, cause: msg },
    );
  }
}

/**
 * Return all relationship records, ordered by last_interaction descending.
 * @throws ConsciousnessError on DB read failure.
 */
export function getAllRelationships(db: Database.Database): Relationship[] {
  try {
    const rows = db
      .prepare('SELECT * FROM relationships ORDER BY last_interaction DESC')
      .all() as RelationshipRow[];
    log.debug({ count: rows.length }, 'All relationships loaded');
    return rows.map(rowToRelationship);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getAllRelationships DB error: ${msg}`,
      'consciousness_relationship_model_db_read',
      { cause: msg },
    );
  }
}
