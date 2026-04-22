/**
 * @file index.ts
 * @description Public facade for the prospective-memory subsystem.
 *
 * ProspectiveMemory wraps the store and trigger-matcher behind a clean
 * class API and owns the ConsciousnessDB reference for this subsystem.
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import { genId } from '../../shared/utils.js';
import {
  saveIntention,
  getPending,
  updateStatus,
  expirePast,
} from './store.js';
import { checkTriggers } from './trigger-matcher.js';
import type { Intention, IntentionInput, TriggerContext } from './types.js';

// Re-export types for consumers
export type { Intention, IntentionInput, TriggerContext } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('prospective-memory');

// ---------------------------------------------------------------------------
// ProspectiveMemory class
// ---------------------------------------------------------------------------

/**
 * High-level interface to prospective memory (intentions).
 *
 * Usage:
 * ```ts
 * const pm = new ProspectiveMemory(consciousnessDB);
 * pm.addIntention({ description: 'Follow up', triggerType: 'time', triggerCondition: '2026-04-01T09:00:00Z' });
 * const fired = pm.checkTriggers({ time: new Date().toISOString(), userId: 'u_123' });
 * ```
 */
export class ProspectiveMemory {
  private readonly db: ReturnType<ConsciousnessDB['getDb']>;

  /**
   * @param consciousnessDB - Initialised ConsciousnessDB instance.
   * @throws ConsciousnessError if the DB is not open.
   */
  constructor(consciousnessDB: ConsciousnessDB) {
    this.db = consciousnessDB.getDb();
    log.info('ProspectiveMemory initialised');
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  /**
   * Create and persist a new intention.
   *
   * @param input - Caller-supplied intention fields.
   * @returns The fully-formed Intention that was stored.
   * @throws ConsciousnessError on validation or write failure.
   */
  addIntention(input: IntentionInput): Intention {
    if (!input || typeof input.description !== 'string' || input.description.trim().length === 0) {
      throw new ConsciousnessError(
        'IntentionInput.description is required',
        'consciousness_invalid_input',
        { input },
      );
    }

    const now = new Date().toISOString();

    const intention: Intention = {
      id: genId(),
      description: input.description.trim(),
      triggerType: input.triggerType,
      triggerCondition: input.triggerCondition,
      status: 'pending',
      createdAt: now,
      triggeredAt: null,
      completedAt: null,
      expiresAt: input.expiresAt ?? null,
      sourceEpisodeId: input.sourceEpisodeId ?? null,
    };

    saveIntention(this.db, intention);

    log.info(
      { id: intention.id, triggerType: intention.triggerType },
      'Intention added',
    );

    return intention;
  }

  /**
   * Mark an intention as completed.
   *
   * @param id - ID of the intention to complete.
   * @throws ConsciousnessError if id is invalid or write fails.
   */
  completeIntention(id: string): void {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new ConsciousnessError(
        'completeIntention: id must be a non-empty string',
        'consciousness_invalid_input',
        { id },
      );
    }

    updateStatus(this.db, id, 'completed');
    log.info({ id }, 'Intention marked completed');
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /**
   * Return all intentions currently in 'pending' status.
   *
   * @returns Array of pending Intention objects.
   */
  getPending(): Intention[] {
    return getPending(this.db);
  }

  // -------------------------------------------------------------------------
  // Trigger evaluation
  // -------------------------------------------------------------------------

  /**
   * Evaluate all pending intentions against the supplied context.
   * Matching intentions are transitioned to 'triggered' status.
   *
   * @param context - Current execution context snapshot.
   * @returns Array of intentions that fired in this call.
   */
  checkTriggers(context: TriggerContext): Intention[] {
    return checkTriggers(this.db, context);
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /**
   * Expire all pending intentions whose expiresAt is in the past.
   *
   * @returns Number of intentions that were expired.
   */
  expirePast(): number {
    const count = expirePast(this.db);
    if (count > 0) {
      log.info({ count }, 'Expired past-due intentions');
    }
    return count;
  }
}
