/**
 * @file cognition/re-anchor-emitter.ts
 * @description Fail-open helper that fires a re-anchor event into two sinks:
 *   1. TrustTierTracker — records a 're-anchor' outcome (+0.5 trust signal).
 *   2. audit_chain table — writes a marker row that ReAnchorMonitor can classify.
 *
 * Designed for three call sites (post-veto, post-discordance, post-dispatch)
 * and the cli.ts startup emission. Factory pattern keeps each call site decoupled —
 * no circular imports, no shared state.
 *
 * Extends re-anchor trigger coverage beyond startup.
 */

import { randomUUID } from 'crypto';
import { createLogger } from '../shared/logger.js';

const log = createLogger('cognition:re-anchor-emitter');

// ---------------------------------------------------------------------------
// Duck-typed interfaces — no real imports from other modules.
// ---------------------------------------------------------------------------

/** Minimal interface for a TrustTierTracker. Matches recordOutcome signature. */
export interface TrustTrackerLike {
  recordOutcome(outcome: { kind: string; timestamp: number }): void;
}

/** Minimal interface for an audit DB. Matches the pattern used in cli.ts. */
export interface AuditDbLike {
  prepare(sql: string): {
    run(...params: unknown[]): void;
  };
}

// ---------------------------------------------------------------------------
// Core emitter (not exported — only the factory is public)
// ---------------------------------------------------------------------------

/**
 * Writes a re-anchor event to both sinks, fail-open.
 * Never throws under any circumstance.
 *
 * Audit chain learned text format: 'identity re-anchor post-<trigger>'
 * so that ReAnchorMonitor.classifyTrigger() can match the keyword.
 *
 * @param trigger  - One of: 'startup' | 'post-veto' | 'post-discordance' | 'post-dispatch'
 * @param auditDb  - Optional DB reference; skip audit write if absent.
 * @param tracker  - Optional TrustTierTracker; skip trust write if absent.
 */
function emitReAnchor(
  trigger: string,
  auditDb: AuditDbLike | undefined | null,
  tracker: TrustTrackerLike | undefined | null,
): void {
  const now = Date.now();
  const learned = `identity re-anchor ${trigger}`;

  // Write 1: TrustTierTracker outcome
  if (tracker) {
    try {
      tracker.recordOutcome({ kind: 're-anchor', timestamp: now });
      log.debug({ event: 'reanchor.emit.trust', trigger }, 'Re-anchor: trust tracker recorded');
    } catch (err: unknown) {
      // Fail-open — loss of a trust event is non-fatal
      log.warn({ err: String(err), trigger }, 'Re-anchor: trust tracker write failed (non-fatal)');
    }
  }

  // Write 2: audit_chain row
  if (auditDb) {
    try {
      auditDb.prepare(
        `INSERT OR IGNORE INTO audit_chain (id, ts, learned, mistake, commitment, ttl_days)
         VALUES (?, ?, ?, NULL, NULL, NULL)`,
      ).run(randomUUID(), now, learned);
      log.debug({ event: 'reanchor.emit.audit', trigger }, 'Re-anchor: audit_chain row inserted');
    } catch (err: unknown) {
      // Fail-open — loss of audit row is non-fatal
      log.warn({ err: String(err), trigger }, 'Re-anchor: audit_chain write failed (non-fatal)');
    }
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a zero-argument re-anchor emitter bound to a specific trigger string.
 *
 * Usage (cli.ts or any wiring site):
 * ```ts
 * const emitPostVeto = createReAnchorEmitter('post-veto', caDb, sleepTrustTracker);
 * setVetoReAnchorCallback(emitPostVeto);
 * ```
 *
 * The returned function NEVER throws — all errors are swallowed internally.
 *
 * @param trigger  - Trigger label used in the audit row's 'learned' column.
 * @param auditDb  - Optional DB with prepare() for audit_chain inserts.
 * @param tracker  - Optional TrustTierTracker for recordOutcome('re-anchor').
 * @returns        - A zero-argument fire-and-forget function.
 */
export function createReAnchorEmitter(
  trigger: string,
  auditDb: AuditDbLike | undefined | null,
  tracker: TrustTrackerLike | undefined | null,
): () => void {
  return (): void => {
    try {
      emitReAnchor(trigger, auditDb, tracker);
    } catch (err: unknown) {
      // Ultimate fail-safe — should never reach here since emitReAnchor is already fail-open
      log.warn({ err: String(err), trigger }, 'Re-anchor: unexpected error in emitter (non-fatal)');
    }
  };
}
