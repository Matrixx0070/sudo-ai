/**
 * @file budget.ts
 * @description Cognitive budget calculation and thought-tier allocation for the
 * attention-system.
 *
 * All functions are pure (no side-effects beyond logging) and perform full
 * input validation before computing results.
 */

import { createLogger } from '../../shared/logger.js';
import type { BodyState, ThoughtTier } from '../types.js';
import type { CognitiveBudget } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('consciousness:attention-system');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum attention units that can ever be allocated in a single cycle. */
const MAX_BUDGET_UNITS = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a number to the closed interval [min, max].
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Assert that a BodyState field is a finite number in [0, 1].
 * Throws a TypeError with a descriptive message on failure.
 */
function assertBodyField(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(
      `calculateBudget: bodyState.${field} must be a finite number in [0, 1], got ${String(value)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// calculateBudget
// ---------------------------------------------------------------------------

/**
 * Derive the cognitive budget for the current processing cycle from the AI's
 * simulated body state.
 *
 * Formula:
 *   totalBudget = clamp((energy * 0.4 + clarity * 0.6) * 100, 0, 100)
 *
 * @param bodyState - Current somatic snapshot.
 * @returns A fresh CognitiveBudget with `used = 0`.
 * @throws {TypeError} If bodyState fields are out of range.
 */
export function calculateBudget(bodyState: BodyState): CognitiveBudget {
  if (bodyState === null || typeof bodyState !== 'object') {
    throw new TypeError('calculateBudget: bodyState must be a non-null object');
  }

  assertBodyField(bodyState.energy, 'energy');
  assertBodyField(bodyState.clarity, 'clarity');

  const raw = (bodyState.energy * 0.4 + bodyState.clarity * 0.6) * MAX_BUDGET_UNITS;
  const totalBudget = clamp(Math.round(raw * 1000) / 1000, 0, MAX_BUDGET_UNITS);

  const budget: CognitiveBudget = {
    totalBudget,
    used: 0,
    remaining: totalBudget,
  };

  log.debug(
    { energy: bodyState.energy, clarity: bodyState.clarity, totalBudget },
    'cognitive budget calculated',
  );

  return budget;
}

// ---------------------------------------------------------------------------
// allocateThoughtTier
// ---------------------------------------------------------------------------

/**
 * Select the appropriate thought-processing tier given the current budget and
 * the dominant motivational drive.
 *
 * Rules (evaluated in order):
 *  1. dominantDriveName === 'curiosity' AND remaining > 30  →  'deep'
 *  2. remaining > 10                                         →  'medium'
 *  3. otherwise                                              →  'micro'
 *
 * @param budget             - Current cognitive budget snapshot.
 * @param dominantDriveName  - Name of the highest-intensity active drive.
 * @returns The selected ThoughtTier.
 * @throws {TypeError} If arguments fail validation.
 */
export function allocateThoughtTier(
  budget: CognitiveBudget,
  dominantDriveName: string,
): ThoughtTier {
  if (budget === null || typeof budget !== 'object') {
    throw new TypeError('allocateThoughtTier: budget must be a non-null object');
  }
  if (typeof budget.remaining !== 'number' || !isFinite(budget.remaining)) {
    throw new TypeError('allocateThoughtTier: budget.remaining must be a finite number');
  }
  if (typeof dominantDriveName !== 'string' || dominantDriveName.trim().length === 0) {
    throw new TypeError('allocateThoughtTier: dominantDriveName must be a non-empty string');
  }

  let tier: ThoughtTier;

  if (dominantDriveName === 'curiosity' && budget.remaining > 30) {
    tier = 'deep';
  } else if (budget.remaining > 10) {
    tier = 'medium';
  } else {
    tier = 'micro';
  }

  log.debug(
    { dominantDriveName, remaining: budget.remaining, tier },
    'thought tier allocated',
  );

  return tier;
}
