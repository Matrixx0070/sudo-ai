/**
 * @file state.ts
 * @description EmotionalStateManager — tracks, blends, and persists emotional
 * valence for the SUDO-AI v4 consciousness layer.
 *
 * All state mutations are logged to `emotional_state_log` via better-sqlite3
 * synchronous statements. Decay is applied on demand using half-life math
 * (half-life = 30 minutes).
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import type { BodyState, EmotionalValence, Thought } from '../types.js';
import { analyzeEmotionalContent } from './analyzer.js';

const log = createLogger('consciousness:emotional-memory');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Decay half-life in milliseconds (30 minutes). */
const HALF_LIFE_MS = 30 * 60 * 1_000;

/** Calm baseline — the emotional attractor the system drifts toward. */
const CALM_BASELINE: EmotionalValence = {
  tags: ['calm'],
  dominantEmotion: 'calm',
  intensity: 0.3,
};

// ---------------------------------------------------------------------------
// Row shape returned from emotional_state_log queries
// ---------------------------------------------------------------------------

interface EmotionalStateRow {
  valence: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// EmotionalStateManager
// ---------------------------------------------------------------------------

/**
 * Manages the AI's current emotional valence in memory and persists
 * a time-series log to SQLite for historical queries.
 */
export class EmotionalStateManager {
  private currentState: EmotionalValence;
  private readonly cdb: ConsciousnessDB;

  constructor(cdb: ConsciousnessDB) {
    if (!cdb) {
      throw new ConsciousnessError(
        'EmotionalStateManager requires a ConsciousnessDB instance',
        'consciousness_emotional_invalid_db',
      );
    }
    this.cdb = cdb;
    // Start with a calm, low-intensity baseline.
    this.currentState = { ...CALM_BASELINE };
    log.info({ initialState: this.currentState }, 'EmotionalStateManager initialised');
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /**
   * Return the current in-memory emotional valence snapshot.
   */
  getCurrentState(): EmotionalValence {
    return { ...this.currentState };
  }

  // -------------------------------------------------------------------------
  // Update methods
  // -------------------------------------------------------------------------

  /**
   * Analyse a Thought's content and blend the result into the current state.
   *
   * @param thought - The thought to process.
   * @returns The updated EmotionalValence.
   */
  updateFromThought(thought: Thought): EmotionalValence {
    if (!thought?.content) {
      log.warn({ thoughtId: thought?.id }, 'updateFromThought: missing content, skipping');
      return this.getCurrentState();
    }

    const updated = analyzeEmotionalContent(thought.content, this.currentState);
    this.currentState = updated;
    this._persist(updated, `thought:${thought.source}`);

    log.debug(
      { thoughtId: thought.id, dominant: updated.dominantEmotion, intensity: updated.intensity },
      'State updated from thought',
    );
    return { ...updated };
  }

  /**
   * Apply a direct outcome signal to the emotional state.
   * Positive outcomes boost joy/pride, negative boost frustration, neutral boost calm.
   *
   * @param outcome - 'positive' | 'negative' | 'neutral'
   * @returns The updated EmotionalValence.
   */
  updateFromOutcome(outcome: 'positive' | 'negative' | 'neutral'): EmotionalValence {
    const BOOST = 0.2;
    let syntheticText: string;

    switch (outcome) {
      case 'positive':
        syntheticText = 'success achieved won celebrate brilliant milestone completed';
        break;
      case 'negative':
        syntheticText = 'error failed broken stuck bug crash wrong';
        break;
      case 'neutral':
        syntheticText = 'stable consistent steady nominal balanced';
        break;
      default: {
        const _exhaustive: never = outcome;
        log.warn({ outcome: _exhaustive }, 'updateFromOutcome: unknown outcome type');
        syntheticText = '';
      }
    }

    // Run through analyzer with a mild intensity boost applied after.
    let updated = analyzeEmotionalContent(syntheticText, this.currentState);

    // Clamp intensity nudge.
    updated = {
      ...updated,
      intensity: Math.min(1, updated.intensity + BOOST),
    };

    this.currentState = updated;
    this._persist(updated, `outcome:${outcome}`);

    log.debug({ outcome, dominant: updated.dominantEmotion, intensity: updated.intensity },
      'State updated from outcome');
    return { ...updated };
  }

  /**
   * Adjust emotional state based on the AI's simulated somatic (body) state.
   * Low energy (<= 0.3) nudges toward calm/boredom; high energy (>= 0.7) toward determination.
   *
   * @param body - Current BodyState snapshot.
   * @returns The updated EmotionalValence.
   */
  updateFromBodyState(body: BodyState): EmotionalValence {
    if (!body || typeof body.energy !== 'number') {
      throw new ConsciousnessError(
        'updateFromBodyState: invalid BodyState — missing energy field',
        'consciousness_emotional_invalid_body',
        { body: String(body) },
      );
    }

    let syntheticText: string;

    if (body.energy <= 0.3) {
      syntheticText = 'quiet slow routine idle waiting peaceful balanced';
    } else if (body.energy >= 0.7) {
      syntheticText = 'must focus push grind commit persist going to';
    } else {
      syntheticText = 'stable steady consistent nominal';
    }

    const updated = analyzeEmotionalContent(syntheticText, this.currentState);
    this.currentState = updated;
    this._persist(updated, `body_state:energy=${body.energy.toFixed(2)}`);

    log.debug(
      { energy: body.energy, dominant: updated.dominantEmotion },
      'State updated from body state',
    );
    return { ...updated };
  }

  /**
   * Decay the current emotional state toward the calm baseline.
   * Uses exponential decay: factor = exp(-ln(2) * deltaMs / HALF_LIFE_MS).
   *
   * @param deltaMs - Elapsed time in milliseconds since the last decay call.
   */
  decayToBaseline(deltaMs: number): void {
    if (typeof deltaMs !== 'number' || deltaMs < 0) {
      log.warn({ deltaMs }, 'decayToBaseline: invalid deltaMs, skipping');
      return;
    }
    if (deltaMs === 0) return;

    const decayFactor = Math.exp((-Math.LN2 * deltaMs) / HALF_LIFE_MS);

    // Blend intensity toward baseline intensity.
    const baselineIntensity = CALM_BASELINE.intensity;
    const decayedIntensity =
      baselineIntensity + (this.currentState.intensity - baselineIntensity) * decayFactor;

    // If intensity has nearly reached baseline, snap the emotion to calm too.
    const snapped = Math.abs(decayedIntensity - baselineIntensity) < 0.02;

    this.currentState = snapped
      ? { ...CALM_BASELINE }
      : {
          ...this.currentState,
          intensity: Math.min(1, Math.max(0, decayedIntensity)),
        };

    log.debug(
      { deltaMs, decayFactor: decayFactor.toFixed(4), newIntensity: this.currentState.intensity },
      'Emotional decay applied',
    );
  }

  /**
   * Retrieve the historical emotional state log for the last `hours` hours.
   *
   * @param hours - How many hours back to query (must be > 0).
   * @returns Array of EmotionalValence objects, oldest first.
   */
  getEmotionalHistory(hours: number): EmotionalValence[] {
    if (typeof hours !== 'number' || hours <= 0) {
      throw new ConsciousnessError(
        `getEmotionalHistory: hours must be a positive number, got ${hours}`,
        'consciousness_emotional_invalid_hours',
        { hours },
      );
    }

    const db = this.cdb.getDb();
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();

    try {
      const rows = db
        .prepare<[string], EmotionalStateRow>(
          `SELECT valence, created_at
             FROM emotional_state_log
            WHERE created_at >= ?
            ORDER BY created_at ASC`,
        )
        .all(since);

      const results: EmotionalValence[] = [];
      for (const row of rows) {
        try {
          results.push(JSON.parse(row.valence) as EmotionalValence);
        } catch {
          log.warn({ createdAt: row.created_at }, 'getEmotionalHistory: failed to parse row');
        }
      }

      log.debug({ hours, rowCount: results.length }, 'Emotional history fetched');
      return results;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConsciousnessError(
        `getEmotionalHistory query failed: ${msg}`,
        'consciousness_emotional_history_failed',
        { hours, cause: msg },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Persist an EmotionalValence reading to `emotional_state_log`.
   */
  private _persist(valence: EmotionalValence, source: string): void {
    try {
      const db = this.cdb.getDb();
      db.prepare(
        `INSERT INTO emotional_state_log (valence, source) VALUES (?, ?)`,
      ).run(JSON.stringify(valence), source);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Log but do not throw — a persistence failure must not crash the caller.
      log.error({ source, error: msg }, 'Failed to persist emotional state');
    }
  }
}
