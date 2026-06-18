/**
 * @file tests/brain/costs-energy.test.ts
 * @description Tests for the Wave 10 energy model in costs.ts.
 *
 * Tests:
 *  1.  estimateEnergy returns EnergyEstimate shape
 *  2.  estimateEnergy source is always 'estimated'
 *  3.  estimateEnergy for openai provider uses correct baseline
 *  4.  estimateEnergy for anthropic provider uses correct baseline
 *  5.  estimateEnergy for xai provider uses correct baseline
 *  6.  estimateEnergy for google provider uses correct baseline
 *  7.  estimateEnergy for ollama provider (higher Wh — local hardware)
 *  8.  estimateEnergy for llamacpp provider (local hardware)
 *  9.  estimateEnergy for cloud provider (cloud routing)
 *  10. estimateEnergy unknown provider falls back to default
 *  11. estimateEnergy wh scales with output tokens
 *  12. estimateEnergy flops scales with total tokens
 *  13. estimateEnergy input tokens contribute ~30% of output energy
 *  14. estimateEnergy returns non-negative values always
 *  15. getEnergyProfile returns correct provider string
 *  16. estimateCost still works (no regression)
 *  17. buildTokenUsage still works (no regression)
 *  18. estimateEnergy wh rounded to 6 decimal places
 *  19. Zero tokens → zero energy
 *  20. estimateEnergy flops > 0 for any non-zero tokens
 */

import { describe, it, expect } from 'vitest';
import {
  estimateEnergy,
  getEnergyProfile,
  estimateCost,
  buildTokenUsage,
} from '../../src/core/brain/costs.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('estimateEnergy', () => {
  it('1. returns EnergyEstimate shape', () => {
    const result = estimateEnergy('openai/gpt-4o', 1000, 500);
    expect(result).toHaveProperty('wh');
    expect(result).toHaveProperty('flops');
    expect(result).toHaveProperty('source');
  });

  it('2. source is always "estimated"', () => {
    expect(estimateEnergy('openai/gpt-4o', 1000, 500).source).toBe('estimated');
    expect(estimateEnergy('xai/grok-4-0709', 2000, 1000).source).toBe('estimated');
    expect(estimateEnergy('unknown/model', 100, 50).source).toBe('estimated');
  });

  it('3. openai provider uses smaller Wh per token than local hardware', () => {
    const cloud = estimateEnergy('openai/gpt-4o', 0, 1000);
    const local = estimateEnergy('ollama/llama3', 0, 1000);
    // Cloud APIs consume much less Wh per token than local GPU running
    expect(cloud.wh).toBeLessThan(local.wh);
  });

  it('4. anthropic provider produces positive energy estimate', () => {
    const result = estimateEnergy('anthropic/claude-opus-4-5', 1000, 500);
    expect(result.wh).toBeGreaterThan(0);
    expect(result.flops).toBeGreaterThan(0);
  });

  it('5. xai provider produces positive energy estimate', () => {
    const result = estimateEnergy('xai/grok-4-0709', 1000, 500);
    expect(result.wh).toBeGreaterThan(0);
    expect(result.flops).toBeGreaterThan(0);
  });

  it('6. google provider uses lower Wh (TPU efficiency)', () => {
    const google = estimateEnergy('google/gemini-2.0-flash', 0, 1000);
    const openai = estimateEnergy('openai/gpt-4o', 0, 1000);
    // Google TPU v5 is more energy-efficient than generic cloud
    expect(google.wh).toBeLessThanOrEqual(openai.wh);
  });

  it('7. ollama provider uses higher Wh (local GPU hardware)', () => {
    const ollama = estimateEnergy('ollama/llama3', 0, 1000);
    const cloud  = estimateEnergy('openai/gpt-4o', 0, 1000);
    expect(ollama.wh).toBeGreaterThan(cloud.wh);
  });

  it('8. llamacpp provider uses high Wh (local GPU)', () => {
    const llamacpp = estimateEnergy('llamacpp/mistral', 0, 1000);
    expect(llamacpp.wh).toBeGreaterThan(0.001); // much higher than cloud
  });

  it('9. cloud provider treated as cloud routing', () => {
    const result = estimateEnergy('cloud/routed', 1000, 500);
    expect(result.wh).toBeGreaterThan(0);
    expect(result.wh).toBeLessThan(5); // cloud-scale, not local
  });

  it('10. unknown provider falls back to default profile', () => {
    const result = estimateEnergy('unknown/model-xyz', 1000, 500);
    expect(result.wh).toBeGreaterThan(0);
    expect(result.source).toBe('estimated');
  });

  it('11. wh scales proportionally with output tokens', () => {
    const r1 = estimateEnergy('openai/gpt-4o', 0, 1000);
    const r2 = estimateEnergy('openai/gpt-4o', 0, 2000);
    // Double the output tokens → approximately double the Wh
    expect(r2.wh).toBeCloseTo(r1.wh * 2, 6);
  });

  it('12. flops scales with total tokens', () => {
    const r1 = estimateEnergy('openai/gpt-4o', 1000, 500);
    const r2 = estimateEnergy('openai/gpt-4o', 2000, 1000);
    // r2 has double the total tokens → double the flops
    expect(r2.flops).toBe(r1.flops * 2);
  });

  it('13. input tokens contribute ~30% of output energy rate', () => {
    const outputOnly = estimateEnergy('openai/gpt-4o', 0, 1000);
    const inputOnly  = estimateEnergy('openai/gpt-4o', 1000, 0);
    // Input should be about 30% of output energy for same token count
    const ratio = inputOnly.wh / outputOnly.wh;
    expect(ratio).toBeCloseTo(0.3, 2);
  });

  it('14. always returns non-negative values', () => {
    const result = estimateEnergy('openai/gpt-4o', 0, 0);
    expect(result.wh).toBeGreaterThanOrEqual(0);
    expect(result.flops).toBeGreaterThanOrEqual(0);
  });

  it('15. getEnergyProfile returns correct provider string', () => {
    const profile = getEnergyProfile('openai/gpt-4o');
    expect(profile.provider).toBe('openai');
    expect(profile.whPerKOutputTokens).toBeGreaterThan(0);
    expect(profile.estimatedParamsB).toBeGreaterThan(0);
  });

  it('16. estimateCost still works after energy model addition', () => {
    const cost = estimateCost('openai/gpt-4o', 1000, 500);
    expect(cost).toBeGreaterThan(0);
    expect(typeof cost).toBe('number');
  });

  it('17. buildTokenUsage still works (no regression)', () => {
    const usage = buildTokenUsage('openai/gpt-4o', {
      promptTokens: 1000,
      completionTokens: 500,
    });
    expect(usage.promptTokens).toBe(1000);
    expect(usage.completionTokens).toBe(500);
    expect(usage.estimatedCost).toBeGreaterThan(0);
  });

  it('19. estimateCost discounts cache-read tokens (consciousness-tick shape)', () => {
    // 27k total input, of which 25749 are cache reads (0.1x) + ~1279 uncached (1x).
    const full = estimateCost('claude-oauth/claude-opus-4-8', 27028, 115);
    const cached = estimateCost('claude-oauth/claude-opus-4-8', 27028, 115, 25749, 0);
    // Discounting the read portion must drop the estimate sharply (~5-6x lower).
    expect(cached).toBeLessThan(full / 4);
    // Sanity: matches the hand-computed ~$0.02/tick, not the phantom ~$0.137.
    expect(cached).toBeGreaterThan(0.01);
    expect(cached).toBeLessThan(0.04);
  });

  it('20. claude-oauth/ prefix resolves to the anthropic rate, not the default', () => {
    // Opus 4.8 output is $25/M; the generic default is $20/M. A pure-output call
    // distinguishes them.
    const oauth = estimateCost('claude-oauth/claude-opus-4-8', 0, 1_000_000);
    expect(oauth).toBeCloseTo(25, 5);
  });

  it('21. buildTokenUsage threads the cache split into the cost', () => {
    const cheap = buildTokenUsage('claude-oauth/claude-opus-4-8',
      { promptTokens: 27028, completionTokens: 115 }, { read: 25749, create: 0 });
    const dear = buildTokenUsage('claude-oauth/claude-opus-4-8',
      { promptTokens: 27028, completionTokens: 115 });
    expect(cheap.estimatedCost).toBeLessThan(dear.estimatedCost / 4);
  });

  it('18. wh rounded to 6 decimal places', () => {
    const result = estimateEnergy('openai/gpt-4o', 1000, 500);
    const decimals = result.wh.toString().split('.')[1];
    expect((decimals?.length ?? 0)).toBeLessThanOrEqual(6);
  });

  it('19. zero tokens → zero or near-zero energy', () => {
    const result = estimateEnergy('openai/gpt-4o', 0, 0);
    expect(result.wh).toBe(0);
    expect(result.flops).toBe(0);
  });

  it('20. flops > 0 for any non-zero tokens', () => {
    const result = estimateEnergy('xai/grok-4-0709', 1, 0);
    expect(result.flops).toBeGreaterThan(0);
  });
});
