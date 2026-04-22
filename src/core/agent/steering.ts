/**
 * @file steering.ts
 * @description Mid-execution steering — allows external signals to redirect a
 * running agent without stopping it. Callers can inject context, reprioritize
 * the current task, or issue an abort request.
 *
 * InMemorySteeringChannel is the default implementation suitable for single-
 * process deployments.  Distributed implementations can drop in over the same
 * interface.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:steering');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Actions a steering signal can request. */
export type SteeringAction = 'reprioritize' | 'abort' | 'inject';

/**
 * A steering signal issued to a running agent session.
 *
 * - reprioritize: agent should re-evaluate its current plan
 * - abort:        agent should terminate cleanly at its next safe checkpoint
 * - inject:       agent should incorporate `payload` as new context
 */
export interface SteeringSignal {
  /** What the caller wants the agent to do. */
  action: SteeringAction;
  /** Free-form instruction or context to inject (may be empty for abort). */
  payload: string;
  /** The session this signal targets. */
  sessionId: string;
  /** ISO-8601 timestamp when the signal was created. */
  issuedAt: string;
}

/**
 * Interface for the channel that ferries steering signals to running agents.
 * Implementations may use in-memory maps, Redis pub/sub, etc.
 */
export interface SteeringChannel {
  /**
   * Issue a new steering signal for the given session.
   * Overwrites any previously pending signal for that session.
   *
   * @param sessionId - Target session identifier.
   * @param sig       - Signal fields (sessionId and issuedAt are added automatically).
   */
  signal(
    sessionId: string,
    sig: Omit<SteeringSignal, 'sessionId' | 'issuedAt'>,
  ): void;

  /**
   * Check whether a steering signal is pending for the session.
   * Returns `null` when no signal is waiting.
   *
   * @param sessionId - Session to check.
   */
  checkSteering(sessionId: string): SteeringSignal | null;

  /**
   * Clear the pending signal for a session after the agent has acted on it.
   *
   * @param sessionId - Session whose signal should be dismissed.
   */
  clearSteering(sessionId: string): void;
}

// ---------------------------------------------------------------------------
// InMemorySteeringChannel
// ---------------------------------------------------------------------------

/**
 * Simple in-process steering channel backed by a Map.
 *
 * Thread-safe for the Node.js single-threaded event loop.
 * Not suitable for multi-process or distributed deployments — use a
 * Redis/Postgres-backed implementation for those scenarios.
 */
export class InMemorySteeringChannel implements SteeringChannel {
  private readonly signals = new Map<string, SteeringSignal>();

  /**
   * Issue (or overwrite) a steering signal for the session.
   * Logs at warn level so operators can see redirects in the log stream.
   */
  signal(
    sessionId: string,
    sig: Omit<SteeringSignal, 'sessionId' | 'issuedAt'>,
  ): void {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new TypeError('SteeringChannel.signal: sessionId must be a non-empty string');
    }
    if (!sig.action) {
      throw new TypeError('SteeringChannel.signal: action is required');
    }

    const full: SteeringSignal = {
      ...sig,
      sessionId,
      issuedAt: new Date().toISOString(),
    };

    const had = this.signals.has(sessionId);
    this.signals.set(sessionId, full);

    log.warn(
      { sessionId, action: sig.action, overwrite: had },
      'Steering signal issued',
    );
  }

  /**
   * Return the pending signal for a session, or `null` if none.
   * Does NOT consume the signal — call clearSteering() after acting.
   */
  checkSteering(sessionId: string): SteeringSignal | null {
    if (!sessionId) return null;
    return this.signals.get(sessionId) ?? null;
  }

  /**
   * Remove the pending signal for a session.
   * Safe to call when no signal is pending (no-op).
   */
  clearSteering(sessionId: string): void {
    if (!sessionId) return;
    const existed = this.signals.delete(sessionId);
    if (existed) {
      log.debug({ sessionId }, 'Steering signal cleared');
    }
  }

  // -------------------------------------------------------------------------
  // Introspection (useful for tests and monitoring)
  // -------------------------------------------------------------------------

  /** How many sessions currently have a pending signal. */
  get pendingCount(): number {
    return this.signals.size;
  }

  /**
   * Snapshot of all pending signals.
   * Intended for debugging/monitoring only — do not mutate the returned array.
   */
  listPending(): SteeringSignal[] {
    return [...this.signals.values()];
  }
}
