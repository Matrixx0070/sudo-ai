/**
 * @file tracker.ts
 * @description RelationshipTracker — models and evolves the AI's relationship
 * with each user across interactions.
 *
 * Stage progression, trust trajectory computation, and context formatting
 * are handled here.  DB I/O is fully delegated to store.ts.
 * Synchronous throughout; no async/await.
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import type { RelationshipStage } from '../types.js';
import type { Relationship, RelEpisodeLike, ToMLike } from './types.js';
import {
  saveRelationship,
  getRelationship as storeGetRelationship,
  getAllRelationships,
} from './store.js';

const log = createLogger('relationship-model:tracker');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of shared references to retain. */
const MAX_SHARED_REFERENCES = 20;

/** Number of recent interactions used to compute trust trajectory. */
const TRAJECTORY_WINDOW = 10;

// ---------------------------------------------------------------------------
// RelationshipTracker
// ---------------------------------------------------------------------------

export class RelationshipTracker {
  private readonly db: ReturnType<ConsciousnessDB['getDb']>;
  private readonly tom: ToMLike;

  /**
   * @param cdb - Open ConsciousnessDB instance.
   * @param tom - Duck-typed theory-of-mind object.
   * @throws ConsciousnessError if either dependency is falsy.
   */
  constructor(cdb: ConsciousnessDB, tom: ToMLike) {
    if (!cdb) {
      throw new ConsciousnessError(
        'RelationshipTracker: cdb must be a ConsciousnessDB instance',
        'consciousness_relationship_model_invalid_db',
      );
    }
    if (!tom) {
      throw new ConsciousnessError(
        'RelationshipTracker: tom must be a ToMLike instance',
        'consciousness_relationship_model_invalid_tom',
      );
    }
    this.db = cdb.getDb();
    this.tom = tom;
    log.info('RelationshipTracker initialised');
  }

  // -------------------------------------------------------------------------
  // getRelationship
  // -------------------------------------------------------------------------

  /**
   * Return the persisted Relationship for userId, or create a default one.
   * The default is not persisted until the first updateFromInteraction call.
   *
   * @param userId - User identifier.
   */
  getRelationship(userId: string): Relationship {
    this._validateUserId(userId, 'getRelationship');
    const existing = storeGetRelationship(this.db, userId);
    if (existing) return existing;
    return this._defaultRelationship(userId);
  }

  // -------------------------------------------------------------------------
  // updateFromInteraction
  // -------------------------------------------------------------------------

  /**
   * Incorporate a new episode into the relationship for `userId`.
   *
   * - Increments totalInteractions and updates lastInteraction.
   * - Positive episodes add to sharedReferences (capped at 20) and may
   *   advance the stage.
   * - Negative episodes add to conflictHistory.
   * - Recomputes stage from totalInteractions + conflictHistory recency.
   * - Recomputes trustTrajectory from a sliding window of outcomes.
   *
   * @param userId  - User identifier.
   * @param episode - Duck-typed episode from episodic-memory.
   */
  updateFromInteraction(userId: string, episode: RelEpisodeLike): void {
    this._validateUserId(userId, 'updateFromInteraction');
    if (!episode || !episode.id) {
      throw new ConsciousnessError(
        'updateFromInteraction: episode must be a non-null RelEpisodeLike',
        'consciousness_relationship_model_invalid_episode',
        { userId },
      );
    }

    const rel = this.getRelationship(userId);
    const now = new Date().toISOString();

    rel.totalInteractions += 1;
    rel.lastInteraction = now;

    if (episode.outcome === 'positive' || episode.outcome === 'mixed') {
      const ref = episode.summary.slice(0, 120);
      rel.sharedReferences.push(ref);
      // Keep only the most recent MAX_SHARED_REFERENCES
      if (rel.sharedReferences.length > MAX_SHARED_REFERENCES) {
        rel.sharedReferences = rel.sharedReferences.slice(-MAX_SHARED_REFERENCES);
      }
      // Conflict recency: a positive/mixed interaction ages out one past
      // conflict so the relationship can recover its stage after sustained
      // positive interactions. Without this, conflictHistory is never trimmed
      // and any lifetime conflict permanently pins the stage to 'acquaintance'.
      if (rel.conflictHistory.length > 0) {
        rel.conflictHistory.shift();
      }
    }

    if (episode.outcome === 'negative') {
      rel.conflictHistory.push(episode.summary.slice(0, 120));
    }

    // Update trust trajectory from a synthetic sliding window stored in
    // sharedReferences (positive) vs conflictHistory (negative).
    rel.trustTrajectory = this._computeTrajectory(rel);

    // Recompute stage
    rel.stage = this._computeStage(rel);

    // Enrich communicationEvolution if UserModel is available
    const userModel = this.tom.getUserModel(userId);
    if (userModel && userModel.communicationStyle) {
      rel.communicationEvolution = userModel.communicationStyle;
    }

    saveRelationship(this.db, rel);
    log.debug(
      { userId, stage: rel.stage, totalInteractions: rel.totalInteractions, outcome: episode.outcome },
      'Relationship updated',
    );
  }

  // -------------------------------------------------------------------------
  // getRelationshipContext
  // -------------------------------------------------------------------------

  /**
   * Return a formatted string summarising the relationship for system-prompt
   * injection.
   *
   * @param userId - User identifier.
   */
  getRelationshipContext(userId: string): string {
    this._validateUserId(userId, 'getRelationshipContext');
    const rel = this.getRelationship(userId);

    const lines: string[] = [
      `Relationship with user ${userId}:`,
      `  Stage: ${rel.stage} | Trust: ${rel.trustTrajectory} | Interactions: ${rel.totalInteractions}`,
    ];

    if (rel.sharedReferences.length > 0) {
      const refs = rel.sharedReferences.slice(-3).join('; ');
      lines.push(`  Shared references: ${refs}`);
    }

    if (rel.communicationEvolution) {
      lines.push(`  Communication style: ${rel.communicationEvolution}`);
    }

    if (rel.insideJokes.length > 0) {
      lines.push(`  Inside jokes/callbacks: ${rel.insideJokes.slice(0, 3).join(', ')}`);
    }

    if (rel.conflictHistory.length > 0) {
      lines.push(`  Past conflicts (${rel.conflictHistory.length}): note tension history`);
    }

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // getStage
  // -------------------------------------------------------------------------

  /**
   * Return the current relationship stage for a user.
   *
   * @param userId - User identifier.
   */
  getStage(userId: string): RelationshipStage {
    this._validateUserId(userId, 'getStage');
    return this.getRelationship(userId).stage;
  }

  // -------------------------------------------------------------------------
  // getAllRelationships (admin / inspection)
  // -------------------------------------------------------------------------

  /** Return all tracked relationships. */
  getAllRelationships(): Relationship[] {
    return getAllRelationships(this.db);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _validateUserId(userId: string, caller: string): void {
    if (!userId || typeof userId !== 'string') {
      throw new ConsciousnessError(
        `${caller}: userId must be a non-empty string`,
        'consciousness_relationship_model_invalid_user',
        { userId },
      );
    }
  }

  private _defaultRelationship(userId: string): Relationship {
    const now = new Date().toISOString();
    return {
      userId,
      stage: 'stranger',
      trustTrajectory: 'stable',
      sharedReferences: [],
      communicationEvolution: '',
      insideJokes: [],
      conflictHistory: [],
      totalInteractions: 0,
      firstInteraction: now,
      lastInteraction: now,
    };
  }

  /**
   * Derive relationship stage from interaction count and conflict recency.
   *
   * Rules:
   *  <5 interactions    → 'stranger'
   *  5–19 interactions  → 'acquaintance'  (spec 'developing' maps to this)
   *  20–99 interactions → 'familiar'      (spec 'established')
   *  ≥100 interactions  → 'trusted'       (spec 'deep')
   *  Recent conflicts   → 'intimate' is not awarded; stays or regresses to
   *                       'acquaintance' if conflict is recent
   *
   * Note: 'intimate' can only be set externally; conflict pushes back to
   * 'acquaintance' at minimum.
   */
  private _computeStage(rel: Relationship): RelationshipStage {
    const { totalInteractions, conflictHistory } = rel;

    // Check for recent conflict (last 3 entries are non-empty)
    const recentConflict =
      conflictHistory.length > 0 &&
      conflictHistory.slice(-3).some((c) => c.trim().length > 0);

    if (recentConflict) return 'acquaintance';

    if (totalInteractions < 5) return 'stranger';
    if (totalInteractions < 20) return 'acquaintance';
    if (totalInteractions < 100) return 'familiar';
    return 'trusted';
  }

  /**
   * Compute trust trajectory from the sliding window of positive vs negative
   * interactions tracked via sharedReferences and conflictHistory lengths.
   *
   * Approximation: compare recent references (positive signals) vs recent
   * conflict entries (negative signals) within a TRAJECTORY_WINDOW.
   */
  private _computeTrajectory(rel: Relationship): Relationship['trustTrajectory'] {
    const positiveCount = Math.min(rel.sharedReferences.length, TRAJECTORY_WINDOW);
    const negativeCount = Math.min(rel.conflictHistory.length, TRAJECTORY_WINDOW);
    const total = positiveCount + negativeCount;

    if (total === 0) return 'stable';

    const positiveRatio = positiveCount / total;

    if (positiveRatio > 0.7) return 'improving';
    if (positiveRatio < 0.3) return 'declining';
    return 'stable';
  }
}
