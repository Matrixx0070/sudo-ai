/**
 * @file retry-prompt.test.ts
 * @description Tests for the retry-loop prompt appendix builder.
 */

import { describe, it, expect } from 'vitest';
import {
  buildRetryAppendix,
  clampMaxAttempts,
  shouldRetry,
  type PreviousAttempt,
} from '../../../../src/core/tools/builtin/coder/arsenal-v2/retry-prompt.js';

describe('buildRetryAppendix', () => {
  it('returns empty string when no prior attempts', () => {
    expect(buildRetryAppendix([])).toBe('');
  });

  it('renders one attempt with header + diff + critique', () => {
    const out = buildRetryAppendix([
      { diffSummary: '[✓ applied] str_replace → src/foo.ts', critique: 'Missed the null check upstream.' },
    ]);
    expect(out).toMatch(/PRIOR ATTEMPT\(S\) — REVIEWED AND REJECTED/);
    expect(out).toMatch(/Produce a NEW patch/);
    expect(out).toMatch(/=== Attempt 1 ===/);
    expect(out).toMatch(/DIFF SUMMARY:\n\[✓ applied\]/);
    expect(out).toMatch(/CRITIC:\nMissed the null check upstream\./);
  });

  it('renders multiple attempts in original 1..N order', () => {
    const attempts: PreviousAttempt[] = [
      { diffSummary: 'd1', critique: 'c1' },
      { diffSummary: 'd2', critique: 'c2' },
      { diffSummary: 'd3', critique: 'c3' },
    ];
    const out = buildRetryAppendix(attempts);
    const i1 = out.indexOf('Attempt 1');
    const i2 = out.indexOf('Attempt 2');
    const i3 = out.indexOf('Attempt 3');
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
  });

  it('truncates per-attempt diff at the 3KB cap', () => {
    const big = 'x'.repeat(5000);
    const out = buildRetryAppendix([{ diffSummary: big, critique: 'c' }]);
    expect(out).toMatch(/truncated 1928 chars/); // 5000 - 3072
  });

  it('truncates per-attempt critique at the 1KB cap', () => {
    const bigCritique = 'y'.repeat(2000);
    const out = buildRetryAppendix([{ diffSummary: 'd', critique: bigCritique }]);
    expect(out).toMatch(/truncated 976 chars/); // 2000 - 1024
  });

  it('drops oldest attempts when total exceeds 16KB and notes the drop', () => {
    // Each attempt with full per-cap renders to ~ 3KB + 1KB + headers ≈ 4.1KB.
    // 10 attempts at full size ≈ 41KB, exceeds 16KB total — expect drops.
    const big = 'x'.repeat(3200);
    const bigC = 'y'.repeat(1100);
    const attempts: PreviousAttempt[] = Array.from({ length: 10 }, () => ({
      diffSummary: big,
      critique: bigC,
    }));
    const out = buildRetryAppendix(attempts);
    expect(out).toMatch(/earlier attempt\(s\) omitted to fit prompt budget/);
  });

  it('keeps the most recent attempt when truncating', () => {
    // Build attempts where the critique encodes the index so we can verify
    // which ones survived.
    const attempts: PreviousAttempt[] = Array.from({ length: 8 }, (_, i) => ({
      diffSummary: 'x'.repeat(3200),
      critique: `attempt-marker-${i}`,
    }));
    const out = buildRetryAppendix(attempts);
    expect(out).toMatch(/attempt-marker-7/); // newest must survive
  });
});

describe('shouldRetry', () => {
  const base = { attemptIndex: 1, maxAttempts: 3, applied: 5, criticSkipped: false };

  it('returns true when critic rejects and budget remains', () => {
    expect(shouldRetry({ ...base, criticVerdict: 'needs_revision' })).toBe(true);
  });
  it('returns false when critic approved', () => {
    expect(shouldRetry({ ...base, criticVerdict: 'approve' })).toBe(false);
  });
  it('returns false on critic error (inconclusive, stop)', () => {
    expect(shouldRetry({ ...base, criticVerdict: 'error' })).toBe(false);
  });
  it('returns false when critic was skipped (implicit approve)', () => {
    expect(shouldRetry({ ...base, criticVerdict: 'approve', criticSkipped: true })).toBe(false);
  });
  it('returns false when budget exhausted', () => {
    expect(
      shouldRetry({ ...base, criticVerdict: 'needs_revision', attemptIndex: 3, maxAttempts: 3 }),
    ).toBe(false);
  });
  it('returns false when zero ops applied this round', () => {
    expect(shouldRetry({ ...base, criticVerdict: 'needs_revision', applied: 0 })).toBe(false);
  });
});

describe('clampMaxAttempts', () => {
  it('returns 3 for missing input', () => {
    expect(clampMaxAttempts(undefined)).toBe(3);
    expect(clampMaxAttempts(null)).toBe(3);
  });
  it('returns 3 for NaN / non-numeric', () => {
    expect(clampMaxAttempts('hello')).toBe(3);
    expect(clampMaxAttempts(NaN)).toBe(3);
  });
  it('clamps below 1 up to 1', () => {
    expect(clampMaxAttempts(0)).toBe(1);
    expect(clampMaxAttempts(-5)).toBe(1);
  });
  it('clamps above 5 down to 5', () => {
    expect(clampMaxAttempts(6)).toBe(5);
    expect(clampMaxAttempts(100)).toBe(5);
  });
  it('preserves valid integers in range', () => {
    expect(clampMaxAttempts(1)).toBe(1);
    expect(clampMaxAttempts(3)).toBe(3);
    expect(clampMaxAttempts(5)).toBe(5);
  });
  it('floors non-integer values', () => {
    expect(clampMaxAttempts(2.9)).toBe(2);
    expect(clampMaxAttempts('4')).toBe(4);
  });
});
