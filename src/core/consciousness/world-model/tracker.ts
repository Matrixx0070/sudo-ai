/**
 * @file tracker.ts
 * @description Outcome recording and surprise calculation for the world model.
 *
 * recordOutcome loads a prediction by id, computes surprise magnitude
 * as |confidence - (matched ? 1 : 0)|, adjusts confidence with clamped
 * arithmetic, persists the update, and returns the resolved entry along
 * with the surprise magnitude.
 *
 * All operations are synchronous (better-sqlite3 API).
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import type { WorldModelEntry } from './types.js';
import { getById, updateOutcome } from './store.js';

const log = createLogger('consciousness:world-model:tracker');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum confidence value after clamping. */
const CONFIDENCE_MAX = 0.99;
/** Minimum confidence value after clamping. */
const CONFIDENCE_MIN = 0.01;
/** Confidence boost applied when prediction is confirmed. */
const CONFIRM_DELTA = 0.05;
/** Confidence penalty applied when prediction is violated. */
const VIOLATE_DELTA = 0.1;

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface OutcomeResult {
  /** The updated WorldModelEntry after resolution. */
  entry: WorldModelEntry;
  /**
   * Absolute prediction error magnitude in [0,1].
   * 0 = perfect prediction, 1 = completely wrong.
   */
  surpriseMagnitude: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record the actual outcome of a prediction and update its persisted state.
 *
 * - Loads the prediction by `id`.
 * - Calculates surpriseMagnitude = |confidence - (matched ? 1 : 0)|.
 * - If matched: sets outcome='confirmed', increases confidence by 0.05 (cap 0.99).
 * - If not matched: sets outcome='violated', decreases confidence by 0.1 (floor 0.01).
 * - Persists the updated entry via updateOutcome.
 * - Returns the updated entry and surpriseMagnitude.
 *
 * @param cdb     - Open ConsciousnessDB instance.
 * @param id      - ID of the prediction to resolve.
 * @param actual  - Natural-language description of what actually happened.
 * @param matched - Whether the prediction proved correct.
 * @returns OutcomeResult containing the updated entry and surpriseMagnitude.
 *
 * @throws ConsciousnessError if the prediction is not found or inputs are invalid.
 */
export function recordOutcome(
  cdb: ConsciousnessDB,
  id: string,
  actual: string,
  matched: boolean,
): OutcomeResult {
  if (!id || typeof id !== 'string') {
    throw new ConsciousnessError(
      'recordOutcome: id must be a non-empty string',
      'consciousness_world_model_invalid_entry',
      { id },
    );
  }
  if (typeof actual !== 'string') {
    throw new ConsciousnessError(
      'recordOutcome: actual must be a string',
      'consciousness_world_model_invalid_entry',
      { id },
    );
  }
  if (typeof matched !== 'boolean') {
    throw new ConsciousnessError(
      'recordOutcome: matched must be a boolean',
      'consciousness_world_model_invalid_entry',
      { id },
    );
  }

  // Load existing prediction.
  const existing = getById(cdb, id);
  if (!existing) {
    throw new ConsciousnessError(
      `recordOutcome: prediction not found for id "${id}"`,
      'consciousness_world_model_not_found',
      { id },
    );
  }

  // Calculate surprise: absolute error between confidence and perfect outcome.
  const perfectOutcome = matched ? 1 : 0;
  const surpriseMagnitude = Math.abs(existing.confidence - perfectOutcome);

  // Determine new outcome and adjusted confidence.
  const outcome: WorldModelEntry['outcome'] = matched ? 'confirmed' : 'violated';

  let newConfidence: number;
  if (matched) {
    newConfidence = Math.min(existing.confidence + CONFIRM_DELTA, CONFIDENCE_MAX);
  } else {
    newConfidence = Math.max(existing.confidence - VIOLATE_DELTA, CONFIDENCE_MIN);
  }

  // Persist the update.
  updateOutcome(cdb, id, outcome, actual, newConfidence);

  // Build updated entry for the return value (mirrors what DB now holds).
  const updatedEntry: WorldModelEntry = {
    ...existing,
    outcome,
    actualResult: actual,
    confidence: newConfidence,
    evidenceCount: existing.evidenceCount + 1,
    lastValidated: new Date().toISOString(),
  };

  log.info(
    { id, outcome, surpriseMagnitude, newConfidence },
    'Prediction outcome recorded',
  );

  return { entry: updatedEntry, surpriseMagnitude };
}
