/**
 * @file trigger-matcher.ts
 * @description Evaluates pending intentions against a live TriggerContext and
 * fires (marks 'triggered') any intentions whose conditions are satisfied.
 *
 * All logic is pure and synchronous (better-sqlite3 API).
 * Matching is intentionally liberal — false positives cause re-evaluation;
 * false negatives cause silent misses which are harder to recover from.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import { getPending, updateStatus } from './store.js';
import type { Intention, TriggerContext } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('prospective-memory:trigger-matcher');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate all pending intentions against the supplied context snapshot.
 * Intentions whose conditions match are transitioned to 'triggered' status
 * and their triggeredAt timestamp is set.
 *
 * @param db      - Open better-sqlite3 Database instance.
 * @param context - Current execution context snapshot.
 * @returns Array of Intention objects that were triggered in this call.
 * @throws ConsciousnessError on invalid context or DB error.
 */
export function checkTriggers(
  db: Database.Database,
  context: TriggerContext,
): Intention[] {
  if (!context || typeof context.time !== 'string' || context.time.trim().length === 0) {
    throw new ConsciousnessError(
      'TriggerContext.time must be a non-empty ISO-8601 string',
      'consciousness_invalid_input',
      { context },
    );
  }

  log.debug(
    { userId: context.userId, topic: context.topic, time: context.time },
    'Evaluating trigger context',
  );

  const pending = getPending(db);
  if (pending.length === 0) {
    log.debug('No pending intentions to evaluate');
    return [];
  }

  const triggered: Intention[] = [];

  for (const intention of pending) {
    try {
      if (matchesTrigger(intention, context)) {
        updateStatus(db, intention.id, 'triggered');

        // Build updated copy with triggeredAt set for the returned array
        const fired: Intention = {
          ...intention,
          status: 'triggered',
          triggeredAt: new Date().toISOString(),
        };

        triggered.push(fired);

        log.info(
          {
            id: intention.id,
            triggerType: intention.triggerType,
            triggerCondition: intention.triggerCondition,
            description: intention.description.slice(0, 80),
          },
          'Intention triggered',
        );
      }
    } catch (err: unknown) {
      // Log but do not abort the whole evaluation loop on a single failure
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ id: intention.id, cause: msg }, 'Error evaluating intention trigger');
    }
  }

  log.info(
    { evaluated: pending.length, triggered: triggered.length },
    'Trigger evaluation complete',
  );

  return triggered;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a single intention's trigger condition is satisfied
 * by the current context.
 *
 * @param intention - Pending intention to test.
 * @param context   - Current execution context.
 * @returns true if the intention should fire.
 */
function matchesTrigger(intention: Intention, context: TriggerContext): boolean {
  const condition = intention.triggerCondition;

  switch (intention.triggerType) {
    case 'time': {
      // Fire when wall-clock time has reached or passed the scheduled datetime
      const contextMs = new Date(context.time).getTime();
      const triggerMs = new Date(condition).getTime();

      if (Number.isNaN(contextMs) || Number.isNaN(triggerMs)) {
        log.warn(
          { id: intention.id, condition, contextTime: context.time },
          'Invalid date in time trigger — skipping',
        );
        return false;
      }

      return contextMs >= triggerMs;
    }

    case 'context': {
      // Fire when the incoming message contains the keyword (case-insensitive)
      const message = context.message ?? '';
      return message.toLowerCase().includes(condition.toLowerCase());
    }

    case 'person': {
      // Fire when the active user ID matches the stored condition exactly
      return context.userId === condition;
    }

    case 'topic': {
      // Fire when either the topic label or the message text contains the keyword
      const keyword = condition.toLowerCase();
      const topicMatch = (context.topic ?? '').toLowerCase().includes(keyword);
      const messageMatch = (context.message ?? '').toLowerCase().includes(keyword);
      return topicMatch || messageMatch;
    }

    default: {
      log.warn(
        { id: intention.id, triggerType: intention.triggerType },
        'Unknown triggerType — skipping',
      );
      return false;
    }
  }
}
