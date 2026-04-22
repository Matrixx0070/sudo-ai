/**
 * @file store.ts
 * @description SQLite persistence layer for prospective-memory intentions.
 *
 * All functions are synchronous (better-sqlite3 API).
 * Every mutation is logged and wrapped in a ConsciousnessError on failure.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { Intention } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('prospective-memory:store');

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

function assertString(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConsciousnessError(
      `${field} must be a non-empty string`,
      'consciousness_invalid_input',
      { field, value },
    );
  }
}

// ---------------------------------------------------------------------------
// Public store functions
// ---------------------------------------------------------------------------

/**
 * Persist a new intention record to the database.
 *
 * @param db        - Open better-sqlite3 Database instance.
 * @param intention - Fully-formed Intention object to insert.
 * @throws ConsciousnessError on validation failure or DB write error.
 */
export function saveIntention(db: Database.Database, intention: Intention): void {
  assertString(intention.id, 'intention.id');
  assertString(intention.description, 'intention.description');
  assertString(intention.triggerType, 'intention.triggerType');
  assertString(intention.triggerCondition, 'intention.triggerCondition');

  const validTriggerTypes = ['time', 'context', 'person', 'topic'] as const;
  if (!validTriggerTypes.includes(intention.triggerType as (typeof validTriggerTypes)[number])) {
    throw new ConsciousnessError(
      `Invalid triggerType: ${intention.triggerType}`,
      'consciousness_invalid_input',
      { triggerType: intention.triggerType, valid: validTriggerTypes },
    );
  }

  try {
    db.prepare(`
      INSERT INTO intentions
        (id, description, trigger_type, trigger_condition, status,
         created_at, triggered_at, completed_at, expires_at, source_episode_id)
      VALUES
        (@id, @description, @triggerType, @triggerCondition, @status,
         @createdAt, @triggeredAt, @completedAt, @expiresAt, @sourceEpisodeId)
    `).run({
      id: intention.id,
      description: intention.description,
      triggerType: intention.triggerType,
      triggerCondition: intention.triggerCondition,
      status: intention.status,
      createdAt: intention.createdAt,
      triggeredAt: intention.triggeredAt ?? null,
      completedAt: intention.completedAt ?? null,
      expiresAt: intention.expiresAt ?? null,
      sourceEpisodeId: intention.sourceEpisodeId ?? null,
    });

    log.info({ id: intention.id, triggerType: intention.triggerType }, 'Intention saved');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `Failed to save intention: ${msg}`,
      'consciousness_store_write_failed',
      { id: intention.id, cause: msg },
    );
  }
}

/**
 * Retrieve all pending intentions from the database.
 *
 * @param db - Open better-sqlite3 Database instance.
 * @returns Array of Intention objects with status = 'pending'.
 * @throws ConsciousnessError on DB read error.
 */
export function getPending(db: Database.Database): Intention[] {
  try {
    const rows = db.prepare(`
      SELECT id, description, trigger_type, trigger_condition, status,
             created_at, triggered_at, completed_at, expires_at, source_episode_id
      FROM intentions
      WHERE status = 'pending'
      ORDER BY created_at ASC
    `).all() as Array<Record<string, unknown>>;

    log.debug({ count: rows.length }, 'Fetched pending intentions');

    return rows.map(rowToIntention);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `Failed to fetch pending intentions: ${msg}`,
      'consciousness_store_read_failed',
      { cause: msg },
    );
  }
}

/**
 * Update the status of an intention by ID.
 *
 * @param db     - Open better-sqlite3 Database instance.
 * @param id     - ID of the intention to update.
 * @param status - New status value.
 * @throws ConsciousnessError on validation failure or DB write error.
 */
export function updateStatus(
  db: Database.Database,
  id: string,
  status: Intention['status'],
): void {
  assertString(id, 'id');

  const validStatuses = ['pending', 'triggered', 'completed', 'expired'] as const;
  if (!validStatuses.includes(status as (typeof validStatuses)[number])) {
    throw new ConsciousnessError(
      `Invalid status: ${status}`,
      'consciousness_invalid_input',
      { id, status, valid: validStatuses },
    );
  }

  try {
    const now = new Date().toISOString();

    // Build timestamp fields based on new status
    let triggeredAt: string | null = null;
    let completedAt: string | null = null;

    if (status === 'triggered') triggeredAt = now;
    if (status === 'completed') completedAt = now;

    const result = db.prepare(`
      UPDATE intentions
      SET status       = @status,
          triggered_at = CASE WHEN @triggeredAt IS NOT NULL THEN @triggeredAt ELSE triggered_at END,
          completed_at = CASE WHEN @completedAt IS NOT NULL THEN @completedAt ELSE completed_at END
      WHERE id = @id
    `).run({ id, status, triggeredAt, completedAt });

    if (result.changes === 0) {
      log.warn({ id, status }, 'updateStatus: no intention found with that ID');
    } else {
      log.info({ id, status }, 'Intention status updated');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `Failed to update intention status: ${msg}`,
      'consciousness_store_write_failed',
      { id, status, cause: msg },
    );
  }
}

/**
 * Expire all pending intentions whose expiry timestamp is in the past.
 *
 * @param db - Open better-sqlite3 Database instance.
 * @returns Number of intentions expired.
 * @throws ConsciousnessError on DB write error.
 */
export function expirePast(db: Database.Database): number {
  try {
    const now = new Date().toISOString();

    const result = db.prepare(`
      UPDATE intentions
      SET status = 'expired'
      WHERE status = 'pending'
        AND expires_at IS NOT NULL
        AND expires_at < @now
    `).run({ now });

    const count = result.changes;
    if (count > 0) {
      log.info({ count, now }, 'Expired past-due intentions');
    } else {
      log.debug({ now }, 'No pending intentions to expire');
    }

    return count;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `Failed to expire past intentions: ${msg}`,
      'consciousness_store_write_failed',
      { cause: msg },
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map a raw DB row (snake_case) to an Intention object (camelCase).
 */
function rowToIntention(row: Record<string, unknown>): Intention {
  return {
    id: row['id'] as string,
    description: row['description'] as string,
    triggerType: row['trigger_type'] as Intention['triggerType'],
    triggerCondition: row['trigger_condition'] as string,
    status: row['status'] as Intention['status'],
    createdAt: row['created_at'] as string,
    triggeredAt: (row['triggered_at'] as string | null) ?? null,
    completedAt: (row['completed_at'] as string | null) ?? null,
    expiresAt: (row['expires_at'] as string | null) ?? null,
    sourceEpisodeId: (row['source_episode_id'] as string | null) ?? null,
  };
}
