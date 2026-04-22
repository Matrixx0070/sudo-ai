/**
 * @file assessor.ts
 * @description Pure functions for deriving self-assessments from episode history.
 *
 * No DB access — all inputs are passed in; all outputs are returned.
 * This keeps the assessor independently testable and free of side effects.
 */

import type { CapabilityAssessment } from '../types.js';
import type { EpisodeLike } from './types.js';

// ---------------------------------------------------------------------------
// Level thresholds
// ---------------------------------------------------------------------------

/**
 * Map a success ratio to a text-level label.
 *
 *  ratio < 0.20  → novice
 *  0.20 – 0.40   → developing
 *  0.40 – 0.60   → competent
 *  0.60 – 0.80   → proficient
 *  > 0.80        → expert
 */
function successRatioToLevel(ratio: number): number {
  if (ratio < 0.2) return 0.1;   // novice
  if (ratio < 0.4) return 0.3;   // developing
  if (ratio < 0.6) return 0.5;   // competent
  if (ratio < 0.8) return 0.7;   // proficient
  return 0.9;                     // expert
}

// ---------------------------------------------------------------------------
// assessFromEpisode
// ---------------------------------------------------------------------------

/**
 * Produce an updated CapabilityAssessment (with successCount / failureCount
 * extensions) by applying one new episode to the current assessment.
 *
 * Algorithm
 * ---------
 * 1. Seed or carry forward success_count / failure_count / evidence_count.
 * 2. Increment the appropriate counter based on outcome.
 *    - 'positive'  → success
 *    - 'negative'  → failure
 *    - 'neutral'   → counts for evidence but neither success nor failure
 *    - 'mixed'     → counts as 0.5 success (rounded down for integers: no change)
 * 3. Recompute level from success ratio.
 * 4. Adjust confidence:
 *    - positive: +0.05 (capped at 1)
 *    - negative: −0.05 (floored at 0)
 *    - neutral / mixed: no change; clamp to [0.1, 1]
 * 5. Trend: compare successes in the last 5 slots vs previous 5 (approximated
 *    via total counts and the new episode).
 *
 * @param episode          - The episode to incorporate.
 * @param currentAssessment - Existing assessment or null for a new domain.
 * @returns Updated assessment including successCount and failureCount fields.
 */
export function assessFromEpisode(
  episode: EpisodeLike,
  currentAssessment: (CapabilityAssessment & { successCount?: number; failureCount?: number }) | null,
): CapabilityAssessment & { successCount: number; failureCount: number } {
  if (!episode || !episode.topic) {
    throw new TypeError('assessFromEpisode: episode must have a non-empty topic');
  }

  // --- Seed from current assessment or initialise ---
  let successCount = currentAssessment?.successCount ?? 0;
  let failureCount = currentAssessment?.failureCount ?? 0;
  let evidenceCount = currentAssessment?.evidenceCount ?? 0;
  let confidence = currentAssessment?.confidence ?? 0.5;

  // --- Apply outcome ---
  evidenceCount += 1;

  switch (episode.outcome) {
    case 'positive':
      successCount += 1;
      confidence = clamp01(confidence + 0.05);
      break;
    case 'negative':
      failureCount += 1;
      confidence = clamp01(confidence - 0.05);
      break;
    case 'neutral':
    case 'mixed':
      // No counter change; confidence unchanged
      break;
  }

  // Ensure confidence stays in [0.1, 1]
  confidence = Math.max(0.1, clamp01(confidence));

  // --- Compute level from success ratio ---
  const total = successCount + failureCount;
  const ratio = total > 0 ? successCount / total : 0.5;
  const level = successRatioToLevel(ratio);

  // --- Compute trend ---
  // We approximate "last 5 vs previous 5" using the total evidence window.
  // When evidenceCount < 10 we default to 'stable'.
  const trend = computeTrend(successCount, failureCount, evidenceCount);

  return {
    domain: episode.topic,
    level,
    confidence,
    evidenceCount,
    trend,
    lastAssessed: new Date().toISOString(),
    successCount,
    failureCount,
  };
}

// ---------------------------------------------------------------------------
// computePersonalityFromHistory
// ---------------------------------------------------------------------------

/**
 * Derive a set of personality trait observations from a list of episodes.
 *
 * Heuristic mapping:
 *   - Many topics containing 'code' / 'debug' / 'analysis' → 'analytical'
 *   - Many topics containing 'creat' / 'design' / 'art' / 'story' → 'creative'
 *   - Many episodes with 'negative' outcome that later appear resolved → 'persistent'
 *   - Many 'negative' outcomes with no follow-up resolution → 'cautious'
 *   - High average significance across episodes → 'ambitious'
 *   - High ratio of 'positive' outcomes → 'confident'
 *
 * Returns trait values normalised to [0, 1].
 *
 * @param episodes - Full episode history to analyse.
 */
export function computePersonalityFromHistory(
  episodes: EpisodeLike[],
): Array<{ trait: string; value: number }> {
  if (!Array.isArray(episodes) || episodes.length === 0) {
    return [];
  }

  const n = episodes.length;

  // --- Counters ---
  let analyticalHits = 0;
  let creativeHits = 0;
  let negativeCount = 0;
  let positiveCount = 0;
  let totalSignificance = 0;

  for (const ep of episodes) {
    const t = (ep.topic ?? '').toLowerCase();

    if (/code|debug|analys|logic|engineer|data|algorith|program/.test(t)) {
      analyticalHits++;
    }
    if (/creat|design|art|story|write|music|generat|imagin/.test(t)) {
      creativeHits++;
    }
    if (ep.outcome === 'negative') negativeCount++;
    if (ep.outcome === 'positive') positiveCount++;
    totalSignificance += ep.significance ?? 0.5;
  }

  const avgSignificance = totalSignificance / n;

  // --- Derive trait values ---
  const traits: Array<{ trait: string; value: number }> = [];

  // analytical: proportion of coding/analysis episodes
  const analyticalRatio = analyticalHits / n;
  if (analyticalRatio > 0) {
    traits.push({ trait: 'analytical', value: clamp01(analyticalRatio * 1.2) });
  }

  // creative: proportion of creative episodes
  const creativeRatio = creativeHits / n;
  if (creativeRatio > 0) {
    traits.push({ trait: 'creative', value: clamp01(creativeRatio * 1.2) });
  }

  // persistent vs cautious: how many negative episodes there were
  if (negativeCount > 0) {
    const errorRatio = negativeCount / n;
    if (errorRatio > 0.3) {
      // More than 30 % failures → cautious
      traits.push({ trait: 'cautious', value: clamp01(errorRatio) });
    } else {
      // Encountered errors but kept going → persistent
      traits.push({ trait: 'persistent', value: clamp01(1 - errorRatio) });
    }
  }

  // ambitious: driven by high average significance
  if (avgSignificance > 0.5) {
    traits.push({ trait: 'ambitious', value: clamp01((avgSignificance - 0.5) * 2) });
  }

  // confident: positive outcome ratio
  const positiveRatio = positiveCount / n;
  if (positiveRatio > 0) {
    traits.push({ trait: 'confident', value: clamp01(positiveRatio) });
  }

  return traits;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Approximate trend from aggregate counters.
 *
 * Strategy: split the evidence window into two halves.
 * We assume successes are roughly evenly distributed and project how the last
 * 5 episodes compare to the previous 5 based on global rates.
 *
 * If evidenceCount < 10 we return 'stable' (not enough data).
 */
function computeTrend(
  successCount: number,
  failureCount: number,
  evidenceCount: number,
): 'improving' | 'stable' | 'declining' {
  if (evidenceCount < 10) return 'stable';

  const total = successCount + failureCount;
  if (total === 0) return 'stable';

  // Global success rate
  const globalRate = successCount / total;

  // Expected successes in the last 5 episodes vs previous 5
  // Using a simple recency bias: we weight the last 5 episodes more heavily.
  // Without a time-series we approximate: if the global rate is high, improving;
  // We instead look at which half of the evidence is stronger using the
  // rough heuristic: last-5 contribution = evidenceCount contributes to tail.
  //
  // Concrete rule: compare current success rate to 0.5 baseline.
  if (globalRate > 0.6) return 'improving';
  if (globalRate < 0.4) return 'declining';
  return 'stable';
}
