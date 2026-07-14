/**
 * gw-refactor Phase 2: compaction trigger thresholds for the proactive
 * context-budget gate (src/llm/budget.ts). The agent loop compacts from the
 * estimate, never from a context_exceeded error.
 */
import { describe, it, expect } from 'vitest';
import {
  decideContextBudget,
  COMPACT_THRESHOLD,
  FORCE_THRESHOLD,
} from '../../src/llm/budget.js';

describe('decideContextBudget', () => {
  const WINDOW = 100_000;

  it('is none well under the window', () => {
    expect(decideContextBudget(10_000, WINDOW)).toBe('none');
  });

  it('is none at exactly 80% (threshold is exclusive)', () => {
    expect(decideContextBudget(WINDOW * COMPACT_THRESHOLD, WINDOW)).toBe('none');
  });

  it('compacts just above 80%', () => {
    expect(decideContextBudget(WINDOW * COMPACT_THRESHOLD + 1, WINDOW)).toBe('compact');
  });

  it('still compacts (not force) at exactly 95%', () => {
    expect(decideContextBudget(WINDOW * FORCE_THRESHOLD, WINDOW)).toBe('compact');
  });

  it('forces just above 95%', () => {
    expect(decideContextBudget(WINDOW * FORCE_THRESHOLD + 1, WINDOW)).toBe('force');
  });

  it('forces when over the window entirely', () => {
    expect(decideContextBudget(WINDOW * 2, WINDOW)).toBe('force');
  });

  it('fails open (none) on zero/negative/NaN window', () => {
    expect(decideContextBudget(50_000, 0)).toBe('none');
    expect(decideContextBudget(50_000, -1)).toBe('none');
    expect(decideContextBudget(50_000, Number.NaN)).toBe('none');
  });

  it('fails open (none) on NaN estimate', () => {
    expect(decideContextBudget(Number.NaN, WINDOW)).toBe('none');
  });
});
