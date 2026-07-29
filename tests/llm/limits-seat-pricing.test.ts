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

  /**
   * 2026-07-29: the SAME failure mode, second provider. Ollama Cloud is a flat
   * Pro subscription (session + weekly quotas; extra-usage balance $0 with
   * auto-reload OFF, verified on the account page — it cannot bill). Only the
   * bare `ollama/llama3.2` was in PRICE_TABLE, so every `:cloud` model fell
   * through to DEFAULT_PRICE and was accounted at Claude-Sonnet rates:
   * ~$0.73 per 80k-in/32k-out call, ~$473 of phantom spend in five days. That
   * tripped the $100 daily budget every day, which then also blocked the free
   * claude-oauth seat — a spend cap causing a total outage.
   */
  it('prices ollama cloud models at 0 — subscription seat, not metered', () => {
    expect(estimateCostUsd('ollama/kimi-k2.7-code:cloud', M, M)).toBe(0);
    expect(estimateCostUsd('ollama/glm-5.2:cloud', M, M)).toBe(0);
    expect(estimateCostUsd('ollama:chat', M, M)).toBe(0);
    expect(estimateCostUsd('ollama/llama3.2', M, M)).toBe(0);
  });

  it('the exact production call shape costs 0, not $0.73', () => {
    // 80k in / 32,768 out was the observed coder.arsenal call; under
    // DEFAULT_PRICE ($3/$15 per M) that booked $0.7315.
    expect(estimateCostUsd('ollama/kimi-k2.7-code:cloud', 80_000, 32_768)).toBe(0);
    expect(estimateCostUsd('mystery/model-x', 80_000, 32_768)).toBeCloseTo(0.7315, 4);
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
