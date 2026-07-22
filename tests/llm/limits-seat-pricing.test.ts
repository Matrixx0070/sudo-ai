/**
 * Seat-covered pricing: flat-subscription providers must never accrue phantom
 * metered spend (2026-07-22: 418 claude-oauth calls hit the DEFAULT_PRICE
 * fallback via the `claude-oauth:messages` route key, "spent" $51 of the $50
 * daily budget, and the policy layer degraded/skipped free calls all day).
 */

import { describe, it, expect } from 'vitest';
import { estimateCostUsd } from '../../src/llm/limits.js';

const M = 1_000_000;

describe('estimateCostUsd seat pricing', () => {
  it('prices claude-oauth at 0 under both key shapes (route and provider/model)', () => {
    expect(estimateCostUsd('claude-oauth:messages', M, M)).toBe(0);
    expect(estimateCostUsd('claude-oauth/claude-opus-4-8', M, M)).toBe(0);
    expect(estimateCostUsd('claude-oauth/claude-fable-5', M, M)).toBe(0);
  });

  it('still prices metered providers (budget continues to bound real dollars)', () => {
    expect(estimateCostUsd('anthropic/claude-opus-4-8', M, 0)).toBe(5);
    // xai-oauth grok-4.5 lane bills API credits — deliberately NOT seat-priced.
    expect(estimateCostUsd('xai-oauth/grok-4.5', M, 0)).toBe(3);
  });

  it('unknown models still hit the conservative default estimate', () => {
    expect(estimateCostUsd('mystery/model-x', M, 0)).toBe(3);
  });
});
