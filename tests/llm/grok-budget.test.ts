/**
 * Shared grok usage budget: per-run + per-day call ceilings, day rollover,
 * and exhaustion → GrokBudgetExhaustedError (failover signal).
 */

import { describe, it, expect } from 'vitest';
import { GrokBudget, GrokBudgetExhaustedError } from '../../src/llm/grok-budget.js';

describe('GrokBudget', () => {
  it('allows calls under the per-run ceiling and counts them', () => {
    const b = new GrokBudget({ perRun: 3, perDay: 100 });
    b.guard();
    b.record();
    b.guard();
    b.record();
    expect(b.status().runUsed).toBe(2);
  });

  it('throws when the per-run ceiling is reached', () => {
    const b = new GrokBudget({ perRun: 2, perDay: 100 });
    b.guard();
    b.record();
    b.guard();
    b.record();
    expect(() => b.guard()).toThrow(GrokBudgetExhaustedError);
  });

  it('throws when the per-day ceiling is reached', () => {
    const b = new GrokBudget({ perRun: 100, perDay: 1 });
    b.guard();
    b.record();
    try {
      b.guard();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(GrokBudgetExhaustedError);
      expect((e as Error).message).toMatch(/day: 1\/1/);
    }
  });

  it('resets the per-day counter on a new UTC day', () => {
    let t = Date.parse('2026-07-25T23:00:00Z');
    const b = new GrokBudget({ perRun: 100, perDay: 2, now: () => t });
    b.guard();
    b.record();
    b.guard();
    b.record();
    expect(() => b.guard()).toThrow(GrokBudgetExhaustedError); // day full
    t = Date.parse('2026-07-26T00:30:00Z'); // next day
    expect(() => b.guard()).not.toThrow();
    expect(b.status().dayUsed).toBe(0);
  });
});
