/**
 * @file detector.ts
 * @description Pattern detection functions for the self-evolution subsystem.
 *
 * Contains two pure analysis functions:
 *   - detectFailurePatterns — surfaces recurring errors from the DB
 *   - detectCapabilityGaps  — surfaces weak domains from the self-model
 *
 * No side effects beyond reading from the database.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import type { EvoSelfModelLike, FailurePattern } from './types.js';
import { getUnresolvedFailures } from './store.js';

const log = createLogger('self-evolution:detector');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum occurrence count before a failure is surfaced as a pattern. */
const FAILURE_THRESHOLD = 3;

/**
 * Numeric competency level below which a domain qualifies as a gap.
 * Matches the 'novice' (0.1) and 'developing' (0.3) bands from the
 * self-model's numericLevelToLabel mapping (both fall under 0.4).
 */
const WEAK_LEVEL_THRESHOLD = 0.4;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Identify recurring unresolved errors in the failure_patterns table.
 *
 * @param db - Raw better-sqlite3 database instance.
 * @returns Failure patterns with occurrence_count >= 3, sorted by count DESC.
 */
export function detectFailurePatterns(db: Database.Database): FailurePattern[] {
  const patterns = getUnresolvedFailures(db, FAILURE_THRESHOLD);

  log.debug(
    { count: patterns.length, threshold: FAILURE_THRESHOLD },
    'Failure patterns detected',
  );

  return patterns;
}

/**
 * Identify capability domains where the self-model's assessed level is weak.
 *
 * @param selfModel - Duck-typed self-model that exposes `getWeaknesses()`.
 * @returns Array of domain strings whose numeric level is below the weak threshold.
 */
export function detectCapabilityGaps(selfModel: EvoSelfModelLike): string[] {
  const weaknesses = selfModel.getWeaknesses();

  const gaps = weaknesses
    // The self-model reports `level` as a numeric competency score (0..1);
    // coerce defensively before comparing against the weak threshold.
    .filter((w) => Number(w.level) < WEAK_LEVEL_THRESHOLD)
    .map((w) => w.domain);

  log.debug(
    { total: weaknesses.length, gaps: gaps.length },
    'Capability gaps detected',
  );

  return gaps;
}
