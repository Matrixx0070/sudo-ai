/**
 * @file tests/brain/thinking-inject.test.ts
 * @description resolveThinkingBudget — the claude-oauth interceptor's thinking
 * budget/max_tokens math. Core invariant: budgetTokens < maxTokens <= modelMax,
 * so the API/SDK never caps the total (which truncated replies / risked a 400).
 */
import { describe, it, expect } from 'vitest';
import { resolveThinkingBudget } from '../../src/core/brain/thinking-inject.js';

describe('resolveThinkingBudget', () => {
  it('returns null for non-opus models', () => {
    expect(resolveThinkingBudget('claude-sonnet-4-5-20250929', 8192)).toBeNull();
    expect(resolveThinkingBudget('claude-opus-4-7', 8192)).toBeNull(); // 4-7 not 4-8+
    expect(resolveThinkingBudget('ollama/glm-5.2', 8192)).toBeNull();
    expect(resolveThinkingBudget('', 8192)).toBeNull();
  });

  it('injects for opus-4-8+ and clamps default budget to fit the 32000 ceiling', () => {
    const r = resolveThinkingBudget('claude-opus-4-8', 8192)!;
    expect(r).not.toBeNull();
    // default budget 32768 would overrun 32000; clamped to 32000-4096=27904
    expect(r.budgetTokens).toBe(27904);
    expect(r.maxTokens).toBe(32000);
    // THE invariant that was being violated (cap warning / 400 risk):
    expect(r.budgetTokens).toBeLessThan(r.maxTokens);
    expect(r.maxTokens).toBeLessThanOrEqual(32000);
  });

  it('also handles opus-4-9 / opus-4-10+', () => {
    expect(resolveThinkingBudget('claude-opus-4-9', 8192)).not.toBeNull();
    expect(resolveThinkingBudget('claude-opus-4-12', 8192)).not.toBeNull();
  });

  it('respects SUDO_THINKING_DISABLE=1', () => {
    expect(resolveThinkingBudget('claude-opus-4-8', 8192, { disable: '1' })).toBeNull();
  });

  it('honors a smaller SUDO_THINKING_BUDGET (no clamp needed)', () => {
    const r = resolveThinkingBudget('claude-opus-4-8', 8192, { budget: '10000' })!;
    expect(r.budgetTokens).toBe(10000);
    expect(r.maxTokens).toBe(14096); // 10000 + 4096 headroom
    expect(r.budgetTokens).toBeLessThan(r.maxTokens);
  });

  it('clamps an out-of-range SUDO_THINKING_BUDGET into [1024, ceiling]', () => {
    expect(resolveThinkingBudget('claude-opus-4-8', 0, { budget: '5' })!.budgetTokens).toBe(1024);
    expect(resolveThinkingBudget('claude-opus-4-8', 0, { budget: '999999' })!.budgetTokens).toBe(27904);
  });

  it('SUDO_THINKING_MODEL_MAX override raises the ceiling (e.g. output-128k beta)', () => {
    const r = resolveThinkingBudget('claude-opus-4-8', 8192, { modelMax: '64000' })!;
    expect(r.budgetTokens).toBe(32768); // default budget now fits (64000-4096)
    expect(r.maxTokens).toBe(36864);    // 32768 + 4096
    expect(r.budgetTokens).toBeLessThan(r.maxTokens);
    expect(r.maxTokens).toBeLessThanOrEqual(64000);
  });

  it("respects a caller's larger max_tokens when it already satisfies the invariant", () => {
    const r = resolveThinkingBudget('claude-opus-4-8', 30000)!; // 30000 > budget 27904 and <= 32000
    expect(r.budgetTokens).toBe(27904);
    expect(r.maxTokens).toBe(30000);
  });

  it("clamps a caller's oversized max_tokens down to the ceiling", () => {
    const r = resolveThinkingBudget('claude-opus-4-8', 100000)!; // > 32000
    expect(r.maxTokens).toBe(32000);
    expect(r.budgetTokens).toBeLessThan(r.maxTokens);
  });

  it('invariant holds across a sweep of inputs', () => {
    for (const mm of ['', '8192', '32000', '64000']) {
      for (const b of ['', '1024', '8192', '32768', '65536', '200000']) {
        for (const cur of [0, 4096, 8192, 30000, 200000]) {
          const r = resolveThinkingBudget('claude-opus-4-8', cur, { budget: b, modelMax: mm });
          expect(r).not.toBeNull();
          expect(r!.budgetTokens).toBeGreaterThanOrEqual(1024);
          expect(r!.budgetTokens).toBeLessThan(r!.maxTokens);
          const ceiling = mm === '' ? 32000 : Math.max(8192, parseInt(mm, 10));
          expect(r!.maxTokens).toBeLessThanOrEqual(ceiling);
        }
      }
    }
  });
});
