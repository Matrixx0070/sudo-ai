/**
 * @file model.ts
 * @description WorldModel — the high-level facade for the world-model sub-module.
 *
 * Wraps store.ts, predictor.ts, and tracker.ts behind a class interface.
 * All methods delegate — no SQL or prediction logic lives here.
 *
 * Usage:
 * ```ts
 * const wm = new WorldModel(cdb);
 * const entry = wm.predict('user_intent', 'User will ask for help', 0.8);
 * wm.save(entry);
 * const result = wm.recordOutcome(entry.id, 'User asked for help', true);
 * ```
 */

import { createLogger } from '../../shared/logger.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import type { WorldModelEntry } from './types.js';
import { savePrediction, getPredictions, getPending, getConfidenceForDomain, expireOld } from './store.js';
import { makePrediction } from './predictor.js';
import { recordOutcome as _recordOutcome } from './tracker.js';

const log = createLogger('consciousness:world-model');

// ---------------------------------------------------------------------------
// WorldModel class
// ---------------------------------------------------------------------------

export class WorldModel {
  private readonly cdb: ConsciousnessDB;

  /**
   * @param cdb - An open ConsciousnessDB instance.
   */
  constructor(cdb: ConsciousnessDB) {
    if (!cdb) {
      throw new TypeError('WorldModel: cdb must be a ConsciousnessDB instance');
    }
    this.cdb = cdb;
    log.debug('WorldModel initialised');
  }

  // -------------------------------------------------------------------------
  // Prediction factory + persistence
  // -------------------------------------------------------------------------

  /**
   * Create a new prediction entry (does NOT persist automatically).
   * Call save() after predict() to write to the database.
   *
   * @param domain     - Domain label e.g. 'user_intent', 'task_outcome'.
   * @param prediction - Natural-language prediction.
   * @param confidence - Initial confidence in [0,1].
   * @param expiresAt  - Optional ISO-8601 expiry timestamp.
   * @returns A new WorldModelEntry with outcome='pending'.
   */
  predict(
    domain: string,
    prediction: string,
    confidence: number,
    expiresAt?: string,
  ): WorldModelEntry {
    return makePrediction(domain, prediction, confidence, expiresAt);
  }

  /**
   * Persist a WorldModelEntry to the database.
   *
   * @param entry - The entry to save (typically created via predict()).
   */
  save(entry: WorldModelEntry): void {
    savePrediction(this.cdb, entry);
  }

  // -------------------------------------------------------------------------
  // Outcome recording
  // -------------------------------------------------------------------------

  /**
   * Record the actual outcome of a prediction.
   *
   * Computes surpriseMagnitude = |confidence - (matched ? 1 : 0)|.
   * If matched: increases confidence by 0.05 (cap 0.99).
   * If not matched: decreases confidence by 0.1 (floor 0.01).
   * Increments evidenceCount.
   *
   * Satisfies the WorldModelLike duck-typed interface used by SurpriseEngine.
   *
   * @param id      - The prediction id to resolve.
   * @param actual  - What actually happened.
   * @param matched - Whether the prediction proved correct.
   * @returns Surprise magnitude (absolute prediction error 0..1).
   */
  recordOutcome(id: string, actual: string, matched: boolean): number {
    const { surpriseMagnitude } = _recordOutcome(this.cdb, id, actual, matched);
    log.debug({ id, matched, surpriseMagnitude }, 'Outcome recorded');
    return surpriseMagnitude;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Retrieve predictions, optionally filtered by domain and/or outcome.
   *
   * @param domain  - Optional domain filter.
   * @param outcome - Optional outcome filter.
   * @returns Array of WorldModelEntry objects (may be empty).
   */
  getPredictions(domain?: string, outcome?: string): WorldModelEntry[] {
    return getPredictions(this.cdb, domain, outcome);
  }

  /**
   * Retrieve all predictions with outcome='pending'.
   *
   * @returns Array of pending WorldModelEntry objects ordered by madeAt ASC.
   */
  getPendingPredictions(): WorldModelEntry[] {
    return getPending(this.cdb);
  }

  /**
   * Calculate the average confidence for resolved predictions in a domain.
   *
   * Only considers rows with outcome IN ('confirmed', 'violated').
   * Returns 0.5 if no resolved predictions exist.
   *
   * @param domain - Domain to query.
   * @returns Average confidence in [0,1].
   */
  getConfidenceForDomain(domain: string): number {
    return getConfidenceForDomain(this.cdb, domain);
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /**
   * Mark all pending predictions past their expires_at as 'expired'.
   *
   * @returns Number of rows updated.
   */
  expireOld(): number {
    return expireOld(this.cdb);
  }
}
