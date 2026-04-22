/**
 * @file index.ts
 * @description EmbodiedStateEngine — the public facade for the embodied-state
 * subsystem of SUDO-AI v4.
 *
 * The engine runs a periodic sampling loop that:
 *  1. Collects raw OS metrics via sampler.ts
 *  2. Maps them to a normalised BodyState via mapper.ts
 *  3. Persists the snapshot via store.ts
 *  4. Updates the in-memory cache returned by getState()
 *
 * Errors inside a tick are caught, logged, and silently dropped so a
 * transient OS or DB failure never crashes the host process.
 *
 * Usage:
 * ```ts
 * const engine = new EmbodiedStateEngine(db);
 * engine.start();               // default 30-second interval
 * const state = engine.getState();
 * const mod   = engine.getModifier();
 * engine.stop();
 * ```
 */

import { createLogger } from '../../shared/logger.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import type { BodyState } from '../types.js';
import { sampleMetrics } from './sampler.js';
import { mapToBodyState, createBodyStateModifier } from './mapper.js';
import { saveState, getLatestState } from './store.js';
import type { BodyStateModifier, RawSystemMetrics } from './types.js';

export type { RawSystemMetrics, BodyStateModifier } from './types.js';
export { sampleMetrics } from './sampler.js';
export { mapToBodyState, createBodyStateModifier } from './mapper.js';
export { saveState, getLatestState, getStateHistory } from './store.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('consciousness:embodied-state');

// ---------------------------------------------------------------------------
// Default interval
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// EmbodiedStateEngine
// ---------------------------------------------------------------------------

/**
 * Orchestrates the full embodied-state pipeline on a configurable timer.
 *
 * Thread-safety note: Node.js is single-threaded; the timer callback is
 * non-reentrant by design.  A `_ticking` guard prevents overlap if a tick
 * runs longer than the interval.
 */
export class EmbodiedStateEngine {
  private readonly _cdb: ConsciousnessDB;
  private readonly _modifier: BodyStateModifier;

  /** Cached BodyState from the most recent successful tick. */
  private _cachedState: BodyState | null = null;

  /** NodeJS timer handle, non-null while the engine is running. */
  private _timer: ReturnType<typeof setInterval> | null = null;

  /** Guard flag: true while a tick is in progress. */
  private _ticking = false;

  /** Milliseconds between samples. Set by start(). */
  private _intervalMs: number = DEFAULT_INTERVAL_MS;

  /**
   * Construct an EmbodiedStateEngine.
   *
   * @param cdb - An open ConsciousnessDB instance.  The engine does not close
   *              it — that responsibility remains with the caller.
   */
  constructor(cdb: ConsciousnessDB) {
    if (cdb === undefined || cdb === null) {
      throw new TypeError('EmbodiedStateEngine: cdb must be a ConsciousnessDB instance');
    }
    this._cdb = cdb;
    this._modifier = createBodyStateModifier();

    // Seed cache from DB if a previous state was persisted.
    try {
      const existing = getLatestState(cdb);
      if (existing !== null) {
        this._cachedState = existing;
        log.debug({ sampledAt: existing.sampledAt }, 'engine: seeded cache from DB');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ error: msg }, 'engine: could not seed cache from DB');
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the periodic sampling timer.
   * Idempotent — calling start() on an already-running engine is a no-op.
   *
   * @param intervalMs - Milliseconds between samples (default 30 000).
   *                     Must be >= 1 000 to avoid hammering the OS.
   */
  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this._timer !== null) {
      log.warn({ intervalMs }, 'engine: start() called while already running — ignored');
      return;
    }

    if (intervalMs < 1_000) {
      throw new RangeError(
        `EmbodiedStateEngine.start: intervalMs must be >= 1000, got ${intervalMs}`,
      );
    }

    this._intervalMs = intervalMs;

    // Run one immediate tick then start the interval.
    void this._tick();
    this._timer = setInterval(() => void this._tick(), this._intervalMs);

    log.info({ intervalMs }, 'engine: started');
  }

  /**
   * Stop the sampling timer.
   * Safe to call multiple times; subsequent calls are no-ops.
   */
  stop(): void {
    if (this._timer === null) return;
    clearInterval(this._timer);
    this._timer = null;
    log.info('engine: stopped');
  }

  // -------------------------------------------------------------------------
  // State access
  // -------------------------------------------------------------------------

  /**
   * Return the latest cached BodyState.
   *
   * If the engine has not yet completed its first tick (and the database was
   * empty), returns a neutral safe-default state so callers always receive a
   * valid object.
   *
   * @returns The most recent BodyState snapshot.
   */
  getState(): BodyState {
    if (this._cachedState !== null) return this._cachedState;

    // Return a neutral mid-point state as a safe default before first tick.
    const neutral: BodyState = {
      energy: 0.5,
      clarity: 0.5,
      fullness: 0.5,
      connectivity: 0.5,
      continuity: 0.5,
      sampledAt: new Date().toISOString(),
    };

    log.debug('engine: returning neutral default state (no samples yet)');
    return neutral;
  }

  /**
   * Return the `BodyStateModifier` instance for this engine.
   * The modifier is stateless and shared — no need to create per-call.
   */
  getModifier(): BodyStateModifier {
    return this._modifier;
  }

  // -------------------------------------------------------------------------
  // Internal tick
  // -------------------------------------------------------------------------

  /**
   * Execute a single sample-map-save cycle.
   * Guarded against re-entry; any error is swallowed after logging.
   */
  private async _tick(): Promise<void> {
    if (this._ticking) {
      log.warn('engine: tick skipped — previous tick still in progress');
      return;
    }

    this._ticking = true;

    try {
      const raw: RawSystemMetrics = await sampleMetrics();
      const state: BodyState = mapToBodyState(raw);

      saveState(this._cdb, state, raw);
      this._cachedState = state;

      const mod = this._modifier;
      log.info(
        {
          energy: state.energy.toFixed(3),
          clarity: state.clarity.toFixed(3),
          fullness: state.fullness.toFixed(3),
          connectivity: state.connectivity.toFixed(3),
          continuity: state.continuity.toFixed(3),
          depthMult: mod.getProcessingDepthMultiplier(state).toFixed(3),
          tempDelta: mod.getTemperatureDelta(state).toFixed(1),
          intervalMult: mod.getThoughtIntervalMultiplier(state).toFixed(3),
          sampledAt: state.sampledAt,
        },
        'engine: body state sampled',
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ error: msg }, 'engine: tick failed — state cache unchanged');
    } finally {
      this._ticking = false;
    }
  }
}
