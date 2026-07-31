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

/**
 * The INVERSE failure: a genuinely METERED lane priced at $0.
 *
 * `xai-oauth/grok-build` was priced 0/0 on the premise that the cli-chat-proxy
 * lane was seat-covered. That premise was disproven live on 2026-07-31 — the
 * proxy meters on BOTH principals of the account (`grok-4.5` resolves
 * server-side to `grok-4.5-build`, service_tier "default", cost_in_usd_ticks
 * 7_444_000 on the SuperGrok-bearing team), and `grok-4.5-build-free` 404s.
 * A $0 price told the budget counter the model was free, so no dollar ceiling
 * ever bound it: console.x.ai showed $161.27 invoiced over 30 days.
 *
 * Seat pricing must stay $0; metered pricing must NOT.
 */
describe('metered xai-oauth models are not priced free', () => {
  for (const model of ['xai-oauth/grok-build', 'xai-oauth/grok-composer-2.5-fast']) {
    it(`${model} accrues non-zero estimated spend`, () => {
      expect(estimateCostUsd(model, M, 0)).toBeGreaterThan(0);
      expect(estimateCostUsd(model, 0, M)).toBeGreaterThan(0);
    });
  }

  it('grok-build matches the grok-4.5 rate it actually resolves to', () => {
    expect(estimateCostUsd('xai-oauth/grok-build', M, M)).toBe(
      estimateCostUsd('xai-oauth/grok-4.5', M, M),
    );
  });

  it('genuinely seat-covered routes stay $0 (no regression from the fix)', () => {
    expect(estimateCostUsd('claude-oauth/claude-opus-5', M, M)).toBe(0);
    expect(estimateCostUsd('ollama/llama3.2', M, M)).toBe(0);
  });
});
