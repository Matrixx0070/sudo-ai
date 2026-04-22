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

/** Capability levels considered weak enough to qualify as a gap. */
const WEAK_LEVELS = new Set(['novice', 'developing']);

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
 * @returns Array of domain strings where level is 'novice' or 'developing'.
 */
export function detectCapabilityGaps(selfModel: EvoSelfModelLike): string[] {
  const weaknesses = selfModel.getWeaknesses();

  const gaps = weaknesses
    .filter((w) => WEAK_LEVELS.has(w.level))
    .map((w) => w.domain);

  log.debug(
    { total: weaknesses.length, gaps: gaps.length },
    'Capability gaps detected',
  );

  return gaps;
}
