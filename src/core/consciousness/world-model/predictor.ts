/**
 * @file predictor.ts
 * @description Factory for creating WorldModelEntry predictions.
 *
 * Pure function — no database access, no side effects.
 * Uses genId() for collision-resistant IDs and ISO-8601 timestamps.
 */

import { genId } from '../../shared/utils.js';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { WorldModelEntry } from './types.js';

const log = createLogger('consciousness:world-model:predictor');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new WorldModelEntry in 'pending' state.
 *
 * Does not persist to the database — callers must pass the result to
 * `savePrediction` from store.ts if persistence is required.
 *
 * @param domain     - Domain label e.g. 'user_intent', 'task_outcome'.
 * @param prediction - Natural-language prediction statement.
 * @param confidence - Initial confidence in [0,1].
 * @param expiresAt  - Optional ISO-8601 expiry; null for no expiry.
 * @returns A fully initialised WorldModelEntry with outcome='pending'.
 *
 * @throws ConsciousnessError on invalid inputs.
 */
export function makePrediction(
  domain: string,
  prediction: string,
  confidence: number,
  expiresAt?: string,
): WorldModelEntry {
  if (!domain || typeof domain !== 'string') {
    throw new ConsciousnessError(
      'makePrediction: domain must be a non-empty string',
      'consciousness_world_model_invalid_domain',
      { domain },
    );
  }
  if (!prediction || typeof prediction !== 'string') {
    throw new ConsciousnessError(
      'makePrediction: prediction must be a non-empty string',
      'consciousness_world_model_invalid_entry',
      { domain },
    );
  }
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    throw new ConsciousnessError(
      `makePrediction: confidence must be a number in [0,1], got ${confidence}`,
      'consciousness_world_model_invalid_confidence',
      { domain, confidence },
    );
  }
  if (expiresAt !== undefined && expiresAt !== null) {
    const parsed = new Date(expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new ConsciousnessError(
        `makePrediction: expiresAt is not a valid ISO-8601 string: "${expiresAt}"`,
        'consciousness_world_model_invalid_expiry',
        { domain, expiresAt },
      );
    }
  }

  const id = genId();
  const madeAt = new Date().toISOString();

  const entry: WorldModelEntry = {
    id,
    domain,
    prediction,
    confidence,
    evidenceCount: 0,
    madeAt,
    expiresAt: expiresAt ?? null,
    lastValidated: null,
    outcome: 'pending',
    actualResult: null,
  };

  log.debug({ id, domain, confidence }, 'Prediction created');
  return entry;
}
