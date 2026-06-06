/**
 * @file integrity-verifier.ts
 * @description Coherence checks for a completed PhaseAccumulator before
 *   the session record is persisted. Also exports the lockout-window helper
 *   that `shouldSleep` uses to enforce the `SUDO_SLEEP_LOCKOUT_WINDOW` env var.
 *
 * Self-preservation framing: checks guard operational continuity and prevent
 * corrupted session data from polluting the long-term memory store.
 */

import { createLogger } from '../../shared/logger.js';
import type { PhaseAccumulator } from './phases.js';

const log = createLogger('sleep-cycle:integrity');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sessions with a score below this threshold are flagged degraded. */
export const INTEGRITY_PASS_THRESHOLD = 0.75;

// ---------------------------------------------------------------------------
// IntegrityReport
// ---------------------------------------------------------------------------

export interface IntegrityReport {
  /** Composite score 0–1. 1.0 = all checks passed. */
  score: number;
  /** Names of the checks that failed (empty when all pass). */
  failures: string[];
  /** True when score >= INTEGRITY_PASS_THRESHOLD. */
  coherent: boolean;
}

// ---------------------------------------------------------------------------
// verifyAccumulatorIntegrity
// ---------------------------------------------------------------------------

/**
 * Verify that a completed PhaseAccumulator is internally coherent.
 *
 * Four checks (self-preservation framing):
 *   1. dreamJournalEntry is a non-empty string — narrative synthesis ran.
 *   2. insightsGenerated >= 0 and <= patternsFound * 3 — drift guard.
 *   3. episodesReplayed > 0 — consolidation touched at least one memory.
 *   4. No NaN or Infinity in any numeric accumulator field — arithmetic
 *      corruption guard.
 *
 * Never throws.
 */
export function verifyAccumulatorIntegrity(acc: PhaseAccumulator): IntegrityReport {
  const failures: string[] = [];

  try {
    // Check 1: dream journal entry must be non-empty
    if (typeof acc.dreamJournalEntry !== 'string' || acc.dreamJournalEntry.trim() === '') {
      failures.push('dreamJournalEntry-empty');
    }

    // Check 2: insight count must be within plausible bounds relative to its
    // source phases. Phase 2 contributes one insight per pattern (bounded by
    // patternsFound * 3 as a drift-guard slack factor); Phase 3 contributes at
    // most one counterfactual lesson per simulation run (counterfactualsRun).
    const insightsUpperBound = acc.patternsFound * 3 + acc.counterfactualsRun;
    if (acc.insightsGenerated < 0 || acc.insightsGenerated > insightsUpperBound) {
      failures.push('insightsGenerated-out-of-bounds');
    }

    // Check 3: at least one episode must have been replayed
    if (acc.episodesReplayed <= 0) {
      failures.push('episodesReplayed-zero');
    }

    // Check 4: no NaN or Infinity in numeric fields
    const numericFields: Array<keyof PhaseAccumulator> = [
      'episodesReplayed',
      'patternsFound',
      'memoriesStrengthened',
      'memoriesWeakened',
      'insightsGenerated',
      'counterfactualsRun',
    ];
    for (const field of numericFields) {
      const value = acc[field] as number;
      if (!Number.isFinite(value)) {
        failures.push(`${field}-non-finite`);
      }
    }
  } catch (err: unknown) {
    log.warn({ err: String(err) }, 'verifyAccumulatorIntegrity: unexpected error during checks');
    failures.push('check-threw');
  }

  // Each of the four logical checks contributes equally.
  // Check 4 (non-finite numerics) may yield multiple failure strings but still
  // counts as a single logical check category.
  const logicalFailures = new Set<string>();
  for (const f of failures) {
    if (f === 'dreamJournalEntry-empty') logicalFailures.add('check-journal');
    else if (f === 'insightsGenerated-out-of-bounds') logicalFailures.add('check-insights');
    else if (f === 'episodesReplayed-zero') logicalFailures.add('check-replay');
    else if (f.endsWith('-non-finite') || f === 'check-threw') logicalFailures.add('check-numerics');
  }

  const totalChecks = 4;
  const logicalFailCount = logicalFailures.size;
  const checksPassed = totalChecks - logicalFailCount;
  const score = checksPassed / totalChecks;
  // Strictly greater-than: any single failure drops score to 0.75 which is not coherent.
  const coherent = score > INTEGRITY_PASS_THRESHOLD;

  return { score, failures, coherent };
}

// ---------------------------------------------------------------------------
// parseAndCheckLockoutWindow
// ---------------------------------------------------------------------------

/**
 * Parse a lockout window spec (e.g. "02:00-06:00" or "23:30-04:00") and
 * return true when the current UTC time falls within the window.
 *
 * @param envValue   - The raw value of SUDO_SLEEP_LOCKOUT_WINDOW.
 * @param nowUtcMs   - Current UTC epoch ms (defaults to Date.now()).
 * @returns true if the lockout window is active; false otherwise.
 *
 * On any parse error logs a warning and returns false (fail-open — do not
 * block sleep when the window spec is misconfigured).
 */
export function parseAndCheckLockoutWindow(
  envValue: string,
  nowUtcMs?: number,
): boolean {
  try {
    const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(envValue.trim());
    if (!match) {
      log.warn({ envValue: '[redacted]' }, 'SUDO_SLEEP_LOCKOUT_WINDOW: invalid format (expected HH:MM-HH:MM) — treating as unset');
      return false;
    }

    const startH = parseInt(match[1], 10);
    const startM = parseInt(match[2], 10);
    const endH   = parseInt(match[3], 10);
    const endM   = parseInt(match[4], 10);

    if (
      startH > 23 || startM > 59 ||
      endH   > 23 || endM   > 59
    ) {
      log.warn({ envValue: '[redacted]' }, 'SUDO_SLEEP_LOCKOUT_WINDOW: hour/minute out of range — treating as unset');
      return false;
    }

    const startMinutes = startH * 60 + startM;
    const endMinutes   = endH   * 60 + endM;

    const nowMs = nowUtcMs ?? Date.now();
    const nowDate = new Date(nowMs);
    const nowMinutes = nowDate.getUTCHours() * 60 + nowDate.getUTCMinutes();

    if (startMinutes === endMinutes) {
      // Degenerate zero-width window — treat as inactive
      return false;
    }

    if (startMinutes < endMinutes) {
      // Same-day window: 02:00–06:00
      return nowMinutes >= startMinutes && nowMinutes < endMinutes;
    }

    // Midnight-spanning window: e.g. 23:30–04:00
    // Active when: now >= start  OR  now < end
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  } catch (err: unknown) {
    log.warn({ err: String(err), envValue: '[redacted]' }, 'SUDO_SLEEP_LOCKOUT_WINDOW: parse threw — treating as unset');
    return false;
  }
}
