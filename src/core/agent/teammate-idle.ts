/**
 * @file teammate-idle.ts
 * @description TeammateIdleDetector — polls active sub-agents in a swarm and
 * fires a callback when any agent has been silent beyond a configurable
 * threshold. Designed to be wired to the `teammate:idle` hook event.
 *
 * The detector does NOT kill idle agents — it only notifies. Callers decide
 * whether to reassign work, abort, or simply log the event.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:teammate-idle');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal heartbeat record expected from each active agent. */
export interface AgentHeartbeat {
  /** Unique agent / sub-agent ID. */
  id: string;
  /**
   * Unix epoch milliseconds of the last activity recorded for this agent
   * (e.g. last tool call, last message produced).
   */
  lastActiveAt: number;
}

// ---------------------------------------------------------------------------
// TeammateIdleDetector
// ---------------------------------------------------------------------------

/**
 * Polls the list of active agents on a fixed interval and calls `onIdle` for
 * every agent whose `lastActiveAt` timestamp is older than `thresholdMs`.
 *
 * Usage:
 * ```ts
 * const detector = new TeammateIdleDetector(
 *   () => swarm.getActiveHeartbeats(),
 *   (id) => hooks.emit('teammate:idle', { event: 'teammate:idle', meta: { agentId: id } }),
 *   30_000,   // idle after 30 s
 *   10_000,   // check every 10 s
 * );
 * detector.start();
 * // … later …
 * detector.stop();
 * ```
 *
 * Calling `start()` while already running is a safe no-op (idempotent).
 * Calling `stop()` while not running is also a safe no-op.
 */
export class TeammateIdleDetector {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  /**
   * @param getIdleAgents    - Callback that returns the current list of active
   *                           agents with their last-heartbeat timestamps.
   * @param onIdle           - Called with the agent ID whenever an agent is
   *                           detected as idle.
   * @param thresholdMs      - Milliseconds of silence before an agent is
   *                           considered idle.  Default: 30 000 ms.
   * @param pollIntervalMs   - How often the detector checks agent heartbeats.
   *                           Default: 10 000 ms.
   */
  constructor(
    private readonly getIdleAgents: () => Array<AgentHeartbeat>,
    private readonly onIdle: (agentId: string) => void,
    private readonly thresholdMs: number = 30_000,
    private readonly pollIntervalMs: number = 10_000,
  ) {
    if (typeof getIdleAgents !== 'function') {
      throw new TypeError('TeammateIdleDetector: getIdleAgents must be a function');
    }
    if (typeof onIdle !== 'function') {
      throw new TypeError('TeammateIdleDetector: onIdle must be a function');
    }
    if (thresholdMs <= 0) {
      throw new RangeError('TeammateIdleDetector: thresholdMs must be > 0');
    }
    if (pollIntervalMs <= 0) {
      throw new RangeError('TeammateIdleDetector: pollIntervalMs must be > 0');
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the idle-detection polling loop.
   * Idempotent — calling start() on a running detector is a safe no-op.
   */
  start(): void {
    if (this.intervalId !== null) {
      log.debug({}, 'TeammateIdleDetector already running — skipping start()');
      return;
    }

    log.info(
      { thresholdMs: this.thresholdMs, pollIntervalMs: this.pollIntervalMs },
      'TeammateIdleDetector started',
    );

    this.intervalId = setInterval(() => {
      this.poll();
    }, this.pollIntervalMs);
  }

  /**
   * Stop the idle-detection polling loop.
   * Idempotent — calling stop() when not running is a safe no-op.
   */
  stop(): void {
    if (this.intervalId === null) return;

    clearInterval(this.intervalId);
    this.intervalId = null;
    log.info({}, 'TeammateIdleDetector stopped');
  }

  /** Whether the detector is currently polling. */
  get running(): boolean {
    return this.intervalId !== null;
  }

  // -------------------------------------------------------------------------
  // Internal poll
  // -------------------------------------------------------------------------

  private poll(): void {
    const now = Date.now();
    let agents: Array<AgentHeartbeat>;

    try {
      agents = this.getIdleAgents();
    } catch (err) {
      log.error({ err: String(err) }, 'getIdleAgents() threw — skipping poll cycle');
      return;
    }

    for (const agent of agents) {
      const silenceMs = now - agent.lastActiveAt;
      if (silenceMs > this.thresholdMs) {
        log.warn(
          { agentId: agent.id, silenceMs, thresholdMs: this.thresholdMs },
          'Agent idle threshold exceeded',
        );
        try {
          this.onIdle(agent.id);
        } catch (callbackErr) {
          log.error(
            { agentId: agent.id, err: String(callbackErr) },
            'onIdle callback threw — continuing',
          );
        }
      }
    }
  }
}
