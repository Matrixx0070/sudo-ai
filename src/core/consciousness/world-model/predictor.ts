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

// ---------------------------------------------------------------------------
// Learned confidence prior for the 'tool_use' domain
// ---------------------------------------------------------------------------

/**
 * Minimum number of resolved outcomes before the learned base rate is trusted
 * over the cold-start length heuristic.
 */
export const TOOL_USE_PRIOR_MIN_SAMPLES = 5;
/** Per-message length-feature nudge applied around the learned base rate. */
const LENGTH_NUDGE = 0.1;
/** Message-length threshold (chars) above which tool use is a-priori likelier. */
const LONG_MESSAGE_CHARS = 120;
/** Clamp bounds so the prior stays differentiating (never a degenerate 0 or 1). */
const PRIOR_MIN = 0.05;
const PRIOR_MAX = 0.95;

/** Cold-start heuristic: the legacy fixed prior, kept for the warm-up window. */
function lengthHeuristic(messageLength: number): number {
  return messageLength > LONG_MESSAGE_CHARS ? 0.75 : 0.35;
}

/**
 * Confidence prior for the `tool_use` prediction ("this interaction will
 * require tool use"). Closes the world-model learning loop: once at least
 * {@link TOOL_USE_PRIOR_MIN_SAMPLES} outcomes have resolved, anchor on the
 * empirical match rate and nudge by the message-length feature, instead of the
 * fixed 0.35/0.75 heuristic that made confidence oscillate trip-to-trip
 * regardless of history. Falls back to the heuristic during cold start (or on
 * a non-finite base rate), so warm-up behaviour is unchanged.
 *
 * @param messageLength - Length of the incoming user message in characters.
 * @param baseRate      - Empirical confirmed/(confirmed+violated) for the domain.
 * @param resolved      - Number of resolved predictions backing `baseRate`.
 * @returns A confidence prior in [PRIOR_MIN, PRIOR_MAX].
 */
export function computeToolUsePrior(
  messageLength: number,
  baseRate: number,
  resolved: number,
): number {
  if (!Number.isFinite(resolved) || resolved < TOOL_USE_PRIOR_MIN_SAMPLES || !Number.isFinite(baseRate)) {
    return lengthHeuristic(messageLength);
  }
  const nudge = messageLength > LONG_MESSAGE_CHARS ? LENGTH_NUDGE : -LENGTH_NUDGE;
  return Math.min(PRIOR_MAX, Math.max(PRIOR_MIN, baseRate + nudge));
}
