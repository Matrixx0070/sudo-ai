/**
 * @file attention.ts
 * @description In-memory AttentionManager for SUDO-AI v4.
 *
 * Maintains a capped ring-buffer of AttentionSignals. Signals are ephemeral —
 * nothing is persisted to the database. The winner-selection algorithm gives
 * unconditional priority to user-originated messages and applies light random
 * noise to all other signals to prevent deterministic fixation.
 *
 * Thread-safety note: Node.js is single-threaded so no mutex is required here.
 */

import { createLogger } from '../../shared/logger.js';
import type { AttentionSignal } from '../types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('consciousness:attention-system');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on active signals. Oldest entry is evicted when exceeded. */
const MAX_SIGNALS = 50;

/** Source label that gives a signal unconditional winner priority. */
const USER_MESSAGE_SOURCE = 'user-message';

/** Maximum fractional noise added to non-user signal priority (± 10%). */
const PRIORITY_NOISE_FACTOR = 0.1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return true when `signal` has expired relative to `nowMs`.
 */
function isExpired(signal: AttentionSignal, nowMs: number): boolean {
  const emittedAt = new Date(signal.timestamp).getTime();
  return emittedAt + signal.ttl < nowMs;
}

/**
 * Apply random ±noise to a priority value and clamp the result to [0, 1].
 */
function jitter(priority: number): number {
  const noise = (Math.random() * 2 - 1) * PRIORITY_NOISE_FACTOR;
  return Math.max(0, Math.min(1, priority + noise));
}

/**
 * Validate an incoming AttentionSignal shape.
 * Throws TypeError with a descriptive message on failure.
 */
function validateSignal(signal: AttentionSignal): void {
  if (signal === null || typeof signal !== 'object') {
    throw new TypeError('submitSignal: signal must be a non-null object');
  }
  if (typeof signal.id !== 'string' || signal.id.trim().length === 0) {
    throw new TypeError('submitSignal: signal.id must be a non-empty string');
  }
  if (typeof signal.source !== 'string' || signal.source.trim().length === 0) {
    throw new TypeError('submitSignal: signal.source must be a non-empty string');
  }
  if (typeof signal.priority !== 'number' || !isFinite(signal.priority)) {
    throw new TypeError('submitSignal: signal.priority must be a finite number');
  }
  if (typeof signal.content !== 'string') {
    throw new TypeError('submitSignal: signal.content must be a string');
  }
  if (typeof signal.timestamp !== 'string' || signal.timestamp.trim().length === 0) {
    throw new TypeError('submitSignal: signal.timestamp must be a non-empty ISO-8601 string');
  }
  if (typeof signal.ttl !== 'number' || !isFinite(signal.ttl) || signal.ttl < 0) {
    throw new TypeError('submitSignal: signal.ttl must be a finite non-negative number');
  }
}

// ---------------------------------------------------------------------------
// AttentionManager
// ---------------------------------------------------------------------------

/**
 * Manages the active pool of AttentionSignals entirely in memory.
 *
 * Signals compete for the system's focus each processing cycle. The manager
 * enforces a 50-signal cap, expiry filtering, and user-message priority rules.
 */
export class AttentionManager {
  private readonly signals: AttentionSignal[] = [];

  // -------------------------------------------------------------------------
  // submitSignal
  // -------------------------------------------------------------------------

  /**
   * Add a new signal to the active pool.
   *
   * If the pool is already at capacity ({@link MAX_SIGNALS}), the oldest
   * signal (index 0) is evicted before the new one is appended.
   *
   * @param signal - The signal to enqueue.
   * @throws {TypeError} If the signal fails shape validation.
   */
  submitSignal(signal: AttentionSignal): void {
    validateSignal(signal);

    if (this.signals.length >= MAX_SIGNALS) {
      const evicted = this.signals.shift();
      log.debug({ evictedId: evicted?.id }, 'signal pool at capacity — evicted oldest signal');
    }

    this.signals.push(signal);

    log.debug(
      { id: signal.id, source: signal.source, priority: signal.priority, poolSize: this.signals.length },
      'attention signal submitted',
    );
  }

  // -------------------------------------------------------------------------
  // getWinner
  // -------------------------------------------------------------------------

  /**
   * Select the winning signal for this processing cycle.
   *
   * Algorithm:
   *  1. Discard expired signals from consideration (they remain in the pool
   *     until `drainExpired` is called — this is intentional for auditability).
   *  2. If any active signals originate from 'user-message', the one with the
   *     highest raw priority wins immediately (no noise applied).
   *  3. For all other active signals, add ±10% random noise to each priority
   *     score and return the highest-scoring signal.
   *
   * @returns The winning AttentionSignal, or null if the active pool is empty.
   */
  getWinner(): AttentionSignal | null {
    const now = Date.now();
    const active = this.signals.filter((s) => !isExpired(s, now));

    if (active.length === 0) {
      log.debug('no active signals — winner is null');
      return null;
    }

    // Step 2: user-message signals win unconditionally.
    const userSignals = active.filter((s) => s.source === USER_MESSAGE_SOURCE);
    if (userSignals.length > 0) {
      const winner = userSignals.reduce((best, s) => (s.priority > best.priority ? s : best));
      log.debug(
        { winnerId: winner.id, source: winner.source, priority: winner.priority },
        'user-message signal wins attention',
      );
      return winner;
    }

    // Step 3: apply noise and pick highest effective priority.
    let bestSignal: AttentionSignal = active[0]!;
    let bestEffective = jitter(bestSignal.priority);

    for (let i = 1; i < active.length; i++) {
      const s = active[i]!;
      const effective = jitter(s.priority);
      if (effective > bestEffective) {
        bestEffective = effective;
        bestSignal = s;
      }
    }

    log.debug(
      { winnerId: bestSignal.id, source: bestSignal.source, effectivePriority: bestEffective },
      'attention winner selected via noisy priority',
    );

    return bestSignal;
  }

  // -------------------------------------------------------------------------
  // getActiveSignals
  // -------------------------------------------------------------------------

  /**
   * Return all non-expired signals sorted by raw priority descending.
   *
   * @returns Sorted array of active AttentionSignals (may be empty).
   */
  getActiveSignals(): AttentionSignal[] {
    const now = Date.now();
    const active = this.signals
      .filter((s) => !isExpired(s, now))
      .sort((a, b) => b.priority - a.priority);

    log.debug({ count: active.length }, 'active signals retrieved');
    return active;
  }

  // -------------------------------------------------------------------------
  // drainExpired
  // -------------------------------------------------------------------------

  /**
   * Remove all expired signals from the internal pool.
   *
   * @returns The number of signals removed.
   */
  drainExpired(): number {
    const now = Date.now();
    const before = this.signals.length;

    let write = 0;
    for (let read = 0; read < this.signals.length; read++) {
      if (!isExpired(this.signals[read]!, now)) {
        this.signals[write++] = this.signals[read]!;
      }
    }
    this.signals.length = write;

    const removed = before - this.signals.length;
    if (removed > 0) {
      log.debug({ removed, remaining: this.signals.length }, 'expired signals drained');
    }
    return removed;
  }

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------

  /**
   * Remove all signals from the pool regardless of expiry status.
   */
  clear(): void {
    const count = this.signals.length;
    this.signals.length = 0;
    log.debug({ cleared: count }, 'attention pool cleared');
  }

  // -------------------------------------------------------------------------
  // Diagnostic accessor (useful for tests / introspection)
  // -------------------------------------------------------------------------

  /** Total number of signals currently held in the pool (including expired). */
  get size(): number {
    return this.signals.length;
  }
}
