/**
 * @file engine.ts
 * @description SurpriseEngine — evaluates prediction outcomes and records
 * surprise events with magnitude-scaled triggered actions.
 *
 * Uses only better-sqlite3 synchronous API.  No async/await anywhere.
 */

import { createLogger } from '../../shared/logger.js';
import { genId } from '../../shared/utils.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import { ConsciousnessError } from '../errors.js';
import { getAverageSurprise, getRecentSurprises, saveSurpriseEvent } from './store.js';
import type { EmotionalStateLike, SurpriseEvent, WorldModelLike } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('surprise-engine');

// ---------------------------------------------------------------------------
// Magnitude thresholds
// ---------------------------------------------------------------------------

const THRESHOLD_HIGH = 0.7;
const THRESHOLD_MEDIUM = 0.4;
const THRESHOLD_LOW = 0.2;

// ---------------------------------------------------------------------------
// SurpriseEngine
// ---------------------------------------------------------------------------

/**
 * Evaluates prediction outcomes, computes prediction-error magnitude and
 * direction, selects triggered actions, persists the event, and optionally
 * propagates the outcome to a world model and emotional state.
 */
export class SurpriseEngine {
  private readonly cdb: ConsciousnessDB;
  private readonly worldModel: WorldModelLike | undefined;
  private readonly emotionalState: EmotionalStateLike | undefined;

  /**
   * @param cdb            - Open ConsciousnessDB instance (required).
   * @param worldModel     - Optional duck-typed world-model collaborator.
   * @param emotionalState - Optional duck-typed emotional-state collaborator.
   */
  constructor(
    cdb: ConsciousnessDB,
    worldModel?: WorldModelLike,
    emotionalState?: EmotionalStateLike,
  ) {
    if (!cdb || typeof cdb.getDb !== 'function') {
      throw new ConsciousnessError(
        'SurpriseEngine: cdb must be a valid ConsciousnessDB instance',
        'consciousness_surprise_invalid_cdb',
        {},
      );
    }

    this.cdb = cdb;
    this.worldModel = worldModel;
    this.emotionalState = emotionalState;

    log.info(
      {
        hasWorldModel: worldModel !== undefined,
        hasEmotionalState: emotionalState !== undefined,
      },
      'SurpriseEngine initialised',
    );
  }

  // -------------------------------------------------------------------------
  // evaluate
  // -------------------------------------------------------------------------

  /**
   * Evaluate a prediction outcome and produce a persisted SurpriseEvent.
   *
   * Steps:
   *  1. Validate all inputs.
   *  2. Compute prediction-error magnitude.
   *  3. Determine qualitative direction.
   *  4. Build human-readable description.
   *  5. Select triggered actions by magnitude tier.
   *  6. Persist the event.
   *  7. Optionally propagate to world model and emotional state.
   *  8. Return the event.
   *
   * @param predictionId - ID of the world-model prediction being resolved.
   * @param prediction   - Original prediction text.
   * @param confidence   - Original confidence 0..1.
   * @param domain       - Domain label for the prediction.
   * @param actual       - What actually occurred (free text).
   * @param matched      - Whether the actual outcome matched the prediction.
   * @returns The persisted SurpriseEvent.
   * @throws ConsciousnessError on invalid arguments or DB failure.
   */
  evaluate(
    predictionId: string,
    prediction: string,
    confidence: number,
    domain: string,
    actual: string,
    matched: boolean,
  ): SurpriseEvent {
    // --- Input validation ---------------------------------------------------
    if (!predictionId || typeof predictionId !== 'string') {
      throw new ConsciousnessError(
        'evaluate: predictionId must be a non-empty string',
        'consciousness_surprise_invalid_input',
        { predictionId },
      );
    }
    if (!prediction || typeof prediction !== 'string') {
      throw new ConsciousnessError(
        'evaluate: prediction must be a non-empty string',
        'consciousness_surprise_invalid_input',
        { prediction },
      );
    }
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1 || !isFinite(confidence)) {
      throw new ConsciousnessError(
        `evaluate: confidence must be a number in [0, 1], got ${confidence}`,
        'consciousness_surprise_invalid_input',
        { confidence },
      );
    }
    if (!domain || typeof domain !== 'string') {
      throw new ConsciousnessError(
        'evaluate: domain must be a non-empty string',
        'consciousness_surprise_invalid_input',
        { domain },
      );
    }
    if (!actual || typeof actual !== 'string') {
      throw new ConsciousnessError(
        'evaluate: actual must be a non-empty string',
        'consciousness_surprise_invalid_input',
        { actual },
      );
    }
    if (typeof matched !== 'boolean') {
      throw new ConsciousnessError(
        'evaluate: matched must be a boolean',
        'consciousness_surprise_invalid_input',
        { matched },
      );
    }

    // --- Magnitude ----------------------------------------------------------
    // Absolute distance between confidence and the binary outcome score.
    const outcomeScore = matched ? 1 : 0;
    const magnitude = Math.abs(confidence - outcomeScore);

    // --- Direction ----------------------------------------------------------
    let direction: SurpriseEvent['direction'];
    if (matched && magnitude < THRESHOLD_LOW + 0.1) {
      // matched with low error — pleasantly confirmed
      direction = 'better';
    } else if (!matched && confidence > THRESHOLD_HIGH) {
      // high-confidence prediction that turned out wrong — painful
      direction = 'worse';
    } else {
      direction = 'different';
    }

    // --- Description --------------------------------------------------------
    const matchLabel = matched ? 'matched' : 'did not match';
    const description =
      `[${domain}] Prediction "${prediction}" ${matchLabel} actual outcome ` +
      `"${actual}". Confidence was ${confidence.toFixed(2)}, magnitude ${magnitude.toFixed(2)}, ` +
      `direction: ${direction}.`;

    // --- Triggered actions --------------------------------------------------
    let triggeredActions: string[];
    if (magnitude > THRESHOLD_HIGH) {
      triggeredActions = [
        'deep-analysis',
        'strengthen-episode',
        'update-world-model',
        'notify-user',
      ];
    } else if (magnitude > THRESHOLD_MEDIUM) {
      triggeredActions = ['medium-analysis', 'strengthen-episode', 'update-world-model'];
    } else if (magnitude > THRESHOLD_LOW) {
      triggeredActions = ['update-world-model'];
    } else {
      triggeredActions = [];
    }

    // --- Build event --------------------------------------------------------
    const event: SurpriseEvent = {
      id: genId(),
      predictionId,
      magnitude,
      direction,
      description,
      triggeredActions,
      createdAt: new Date().toISOString(),
    };

    // --- Persist ------------------------------------------------------------
    saveSurpriseEvent(this.cdb.getDb(), event);

    log.info(
      {
        id: event.id,
        predictionId,
        domain,
        magnitude: magnitude.toFixed(3),
        direction,
        actionsCount: triggeredActions.length,
      },
      'Surprise event recorded',
    );

    // --- Propagate to collaborators (best-effort) ---------------------------
    if (this.worldModel) {
      try {
        this.worldModel.recordOutcome(predictionId, actual, matched);
      } catch (err: unknown) {
        log.warn(
          { predictionId, error: err instanceof Error ? err.message : String(err) },
          'WorldModel.recordOutcome failed — continuing',
        );
      }
    }

    if (this.emotionalState) {
      try {
        const valence =
          direction === 'better'
            ? 'positive'
            : direction === 'worse'
              ? 'negative'
              : 'neutral';
        this.emotionalState.updateFromOutcome(valence);
      } catch (err: unknown) {
        log.warn(
          { predictionId, error: err instanceof Error ? err.message : String(err) },
          'EmotionalState.updateFromOutcome failed — continuing',
        );
      }
    }

    return event;
  }

  // -------------------------------------------------------------------------
  // Query helpers
  // -------------------------------------------------------------------------

  /**
   * Return the most recent surprise events.
   *
   * @param count - Maximum number of events (default 10).
   * @returns Array of SurpriseEvent, newest first.
   */
  getRecentSurprises(count: number = 10): SurpriseEvent[] {
    if (!Number.isInteger(count) || count < 1) {
      throw new ConsciousnessError(
        `getRecentSurprises: count must be a positive integer, got ${count}`,
        'consciousness_surprise_invalid_count',
        { count },
      );
    }
    return getRecentSurprises(this.cdb.getDb(), count);
  }

  /**
   * Return the average surprise magnitude over a rolling window.
   *
   * @param hours - Look-back window in hours (default 24).
   * @returns Average magnitude 0..1, or 0 when no events exist in the window.
   */
  getAverageSurprise(hours: number = 24): number {
    if (typeof hours !== 'number' || hours <= 0 || !isFinite(hours)) {
      throw new ConsciousnessError(
        `getAverageSurprise: hours must be a positive finite number, got ${hours}`,
        'consciousness_surprise_invalid_hours',
        { hours },
      );
    }
    return getAverageSurprise(this.cdb.getDb(), hours);
  }
}
