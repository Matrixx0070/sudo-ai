/**
 * @file session-outcome-listener.ts
 * @description Listens for session terminal events and records goal outcomes.
 *
 * Attaches listeners to the SessionStateMachine EventEmitter for both
 * 'session:status:terminated' and 'session:status:archived' events.
 * Idempotent: skips sessions already evaluated via an internal Set.
 */

import type { EventEmitter } from 'node:events';
import { createLogger } from '../shared/logger.js';
import type { GoalEvaluator, GoalEvalResult } from './goal-evaluator.js';
import type { OutcomesLedger, OutcomeType } from '../autonomy/outcomes.js';
import {
  guardMemoryWrite,
  MemoryInjectionError,
} from '../memory/injection-scanner.js';

const log = createLogger('outcomes:session-outcome-listener');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options required to construct a SessionOutcomeListener. */
export interface SessionOutcomeListenerOptions {
  /** The EventEmitter (SessionStateMachine) to listen on. */
  stateMachine: EventEmitter;
  /** Ledger to persist outcomes to. */
  ledger: OutcomesLedger;
  /** Evaluator used to score whether the goal was achieved. */
  evaluator: GoalEvaluator;
  /** Return the goal string for a session, or null if none was set. */
  getSessionGoal: (sessionId: string) => string | null;
  /** Return the last n messages for a session. */
  getRecentMessages: (
    sessionId: string,
    n: number,
  ) => Array<{ role: string; content: string }>;
  /** Return tool success/failure counts for a session. */
  getToolStats: (sessionId: string) => { successCount: number; failureCount: number };
}

// ---------------------------------------------------------------------------
// Terminal event payload (matches state-machine.ts emit shape)
// ---------------------------------------------------------------------------

interface TerminalPayload {
  sessionId: string;
  from: string;
  to: string;
}

// ---------------------------------------------------------------------------
// SessionOutcomeListener
// ---------------------------------------------------------------------------

/**
 * Subscribes to terminal state events on the session state machine.
 * When a session reaches 'terminated' or 'archived', evaluates the goal
 * and records the result to the OutcomesLedger.
 *
 * Idempotency is guaranteed by a Set of already-evaluated session IDs.
 * Call destroy() to detach all listeners (e.g. on graceful shutdown).
 */
export class SessionOutcomeListener {
  private readonly opts: SessionOutcomeListenerOptions;
  private readonly evaluated = new Set<string>();
  private readonly _boundHandler: (payload: TerminalPayload) => Promise<void>;
  private destroyed = false;

  constructor(opts: SessionOutcomeListenerOptions) {
    this.opts = opts;

    // Bind once so we can remove the exact same function reference in destroy()
    this._boundHandler = (payload: TerminalPayload) => this._onTerminal(payload);

    opts.stateMachine.on('session:status:terminated', this._boundHandler);
    opts.stateMachine.on('session:status:archived', this._boundHandler);

    log.info({}, 'SessionOutcomeListener attached to state machine');
  }

  /**
   * Detach all listeners from the state machine. Idempotent.
   */
  destroy(): void {
    if (this.destroyed) {
      log.debug({}, 'SessionOutcomeListener.destroy() called but already destroyed');
      return;
    }
    this.opts.stateMachine.removeListener(
      'session:status:terminated',
      this._boundHandler,
    );
    this.opts.stateMachine.removeListener(
      'session:status:archived',
      this._boundHandler,
    );
    this.destroyed = true;
    log.info({}, 'SessionOutcomeListener detached from state machine');
  }

  /**
   * Handle a terminal state event.
   * Skips if no goal is set for the session, or session was already evaluated.
   */
  private async _onTerminal(payload: TerminalPayload): Promise<void> {
    const { sessionId } = payload;

    if (this.evaluated.has(sessionId)) {
      log.debug({ sessionId }, 'SessionOutcomeListener: session already evaluated, skipping');
      return;
    }

    const goal = this.opts.getSessionGoal(sessionId);
    if (!goal) {
      log.debug({ sessionId }, 'SessionOutcomeListener: no goal set for session, skipping');
      return;
    }

    // Mark as evaluated immediately to prevent duplicate processing
    // (e.g. if both terminated and archived fire for the same session)
    this.evaluated.add(sessionId);

    log.info({ sessionId, to: payload.to }, 'SessionOutcomeListener: evaluating session goal');

    try {
      // ITEM 3: Guard against prompt-injection in goal and recent messages
      // before passing them to the evaluator (which may call an LLM).
      // On injection: log, return early without calling evaluator, and leave
      // sessionId in evaluated set so it won't be retried.
      try {
        guardMemoryWrite(goal, 'outcomes:goal');
      } catch (guardErr: unknown) {
        if (guardErr instanceof MemoryInjectionError) {
          log.warn(
            { sessionId, reasons: guardErr.details?.['reasons'] },
            'SessionOutcomeListener: injection detected in goal — skipping evaluator',
          );
          return;
        }
        throw guardErr;
      }

      const recentMessages = this.opts.getRecentMessages(sessionId, 20);

      for (let i = 0; i < recentMessages.length; i++) {
        const content = recentMessages[i]?.content ?? '';
        try {
          guardMemoryWrite(content, 'outcomes:message');
        } catch (guardErr: unknown) {
          if (guardErr instanceof MemoryInjectionError) {
            log.warn(
              { sessionId, messageIndex: i, reasons: guardErr.details?.['reasons'] },
              'SessionOutcomeListener: injection detected in message — skipping evaluator',
            );
            return;
          }
          throw guardErr;
        }
      }

      const toolStats = this.opts.getToolStats(sessionId);

      const result: GoalEvalResult = await this.opts.evaluator.evaluate({
        sessionId,
        goal,
        recentMessages,
        toolSuccessCount: toolStats.successCount,
        toolFailureCount: toolStats.failureCount,
      });

      const outcomeType: OutcomeType =
        result.outcome === 'success' ? 'goal_completed' : 'error';

      const outcomeId = this.opts.ledger.record({
        type: outcomeType,
        description: `Session ${sessionId} goal evaluation: ${result.outcome} (confidence ${result.confidence.toFixed(2)})`,
        sourceSessionId: sessionId,
        metadata: {
          goal,
          outcome: result.outcome,
          confidence: result.confidence,
          evidence: result.evidence,
          outcome_json: JSON.stringify(result),
          terminalState: payload.to,
        },
      });

      if (outcomeId !== null) {
        log.info(
          { sessionId, outcome: result.outcome, confidence: result.confidence },
          'SessionOutcomeListener: outcome recorded',
        );
      } else {
        log.debug(
          { sessionId, type: result.outcome },
          'outcome already recorded — duplicate silently ignored',
        );
      }
    } catch (err) {
      log.error(
        { sessionId, err },
        'SessionOutcomeListener: failed to evaluate or record outcome',
      );
      // Remove from evaluated set so it could be retried if needed
      this.evaluated.delete(sessionId);
    }
  }
}
