/**
 * Tests for mistake-auto-block-guard.ts — Wave 6Q.
 *
 * Uses a vi.fn() mock for PatternRecognizerLike — no DB needed.
 * 12 tests covering all spec scenarios.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import {
  MistakeAutoBlockGuard,
  type GuardDecision,
  type PatternRecognizerLike,
} from '../../src/core/cognition/mistake-auto-block-guard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FindSimilarFn = PatternRecognizerLike['findSimilar'];

function makeRecognizer(impl?: FindSimilarFn): {
  recognizer: PatternRecognizerLike;
  spy: MockInstance;
} {
  const spy = vi.fn<FindSimilarFn>(impl ?? (() => []));
  return { recognizer: { findSimilar: spy }, spy };
}

function makePattern(signatureHash: string, occurrences: number) {
  return { signatureHash, occurrences };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('MistakeAutoBlockGuard', () => {
  // -------------------------------------------------------------------------
  // 1. Empty text → PASS
  // -------------------------------------------------------------------------
  it('returns PASS with reason "empty input" for empty string', () => {
    const { recognizer } = makeRecognizer();
    const guard = new MistakeAutoBlockGuard({ patternRecognizer: recognizer });
    const result: GuardDecision = guard.check('');
    expect(result.verdict).toBe('PASS');
    expect(result.reason).toBe('empty input');
    expect(result.matchedPatternCount).toBe(0);
    expect(result.topPattern).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 2. Whitespace text → PASS
  // -------------------------------------------------------------------------
  it('returns PASS with reason "empty input" for whitespace-only string', () => {
    const { recognizer } = makeRecognizer();
    const guard = new MistakeAutoBlockGuard({ patternRecognizer: recognizer });
    const result = guard.check('   \t\n  ');
    expect(result.verdict).toBe('PASS');
    expect(result.reason).toBe('empty input');
    expect(result.matchedPatternCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 3. No matching patterns → PASS
  // -------------------------------------------------------------------------
  it('returns PASS when findSimilar returns empty array', () => {
    const { recognizer } = makeRecognizer(() => []);
    const guard = new MistakeAutoBlockGuard({ patternRecognizer: recognizer });
    const result = guard.check('some candidate action text');
    expect(result.verdict).toBe('PASS');
    expect(result.reason).toBe('no matching patterns');
    expect(result.matchedPatternCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 4. 1 match, occurrences=1 → PASS (below warn=2)
  // -------------------------------------------------------------------------
  it('returns PASS when single pattern has occurrences=1 (below warn threshold)', () => {
    const { recognizer } = makeRecognizer(() => [makePattern('aabbccdd00112233', 1)]);
    const guard = new MistakeAutoBlockGuard({ patternRecognizer: recognizer });
    const result = guard.check('do the thing');
    expect(result.verdict).toBe('PASS');
    expect(result.reason).toBe('below warning threshold');
    expect(result.matchedPatternCount).toBe(1);
    expect(result.topPattern).toEqual({ signatureHash: 'aabbccdd00112233', occurrences: 1 });
  });

  // -------------------------------------------------------------------------
  // 5. 1 match, occurrences=2 → WARN (default warn=2)
  // -------------------------------------------------------------------------
  it('returns WARN when single pattern has occurrences=2 (equals default warn threshold)', () => {
    const { recognizer } = makeRecognizer(() => [makePattern('deadbeef12345678', 2)]);
    const guard = new MistakeAutoBlockGuard({ patternRecognizer: recognizer });
    const result = guard.check('delete the config file');
    expect(result.verdict).toBe('WARN');
    expect(result.reason).toBe('similar mistake seen 2 times');
    expect(result.matchedPatternCount).toBe(1);
    expect(result.topPattern).toEqual({ signatureHash: 'deadbeef12345678', occurrences: 2 });
  });

  // -------------------------------------------------------------------------
  // 6. 1 match, occurrences=5 → BLOCK (default block=5)
  // -------------------------------------------------------------------------
  it('returns BLOCK when single pattern has occurrences=5 (equals default block threshold)', () => {
    const { recognizer } = makeRecognizer(() => [makePattern('cafebabe11223344', 5)]);
    const guard = new MistakeAutoBlockGuard({ patternRecognizer: recognizer });
    const result = guard.check('run dangerous command');
    expect(result.verdict).toBe('BLOCK');
    expect(result.reason).toBe('recurring mistake pattern matched 5 times in 7 days');
    expect(result.matchedPatternCount).toBe(1);
    expect(result.topPattern?.occurrences).toBe(5);
  });

  // -------------------------------------------------------------------------
  // 7. 1 match, occurrences=10 → BLOCK
  // -------------------------------------------------------------------------
  it('returns BLOCK when pattern has occurrences=10 (above block threshold)', () => {
    const { recognizer } = makeRecognizer(() => [makePattern('ffee11002233aabb', 10)]);
    const guard = new MistakeAutoBlockGuard({ patternRecognizer: recognizer });
    const result = guard.check('another risky action');
    expect(result.verdict).toBe('BLOCK');
    expect(result.reason).toContain('10 times');
    expect(result.matchedPatternCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 8. Multiple matches, top=5 → BLOCK, topPattern populated with highest
  // -------------------------------------------------------------------------
  it('returns BLOCK and identifies top pattern when multiple matches exist', () => {
    const patterns = [
      makePattern('aaa000000001', 3),
      makePattern('bbb000000002', 5),  // top
      makePattern('ccc000000003', 2),
    ];
    const { recognizer } = makeRecognizer(() => patterns);
    const guard = new MistakeAutoBlockGuard({ patternRecognizer: recognizer });
    const result = guard.check('tool call with repeated error pattern');
    expect(result.verdict).toBe('BLOCK');
    expect(result.matchedPatternCount).toBe(3);
    expect(result.topPattern).toEqual({ signatureHash: 'bbb000000002', occurrences: 5 });
  });

  // -------------------------------------------------------------------------
  // 9a. Custom thresholds {warn:3, block:8}: occurrences=4 → WARN
  // -------------------------------------------------------------------------
  it('returns WARN with custom thresholds when occurrences=4, warn=3, block=8', () => {
    const { recognizer } = makeRecognizer(() => [makePattern('custom001', 4)]);
    const guard = new MistakeAutoBlockGuard({
      patternRecognizer: recognizer,
      thresholds: { warnOccurrences: 3, blockOccurrences: 8, windowDays: 14 },
    });
    const result = guard.check('action with custom thresholds');
    expect(result.verdict).toBe('WARN');
    expect(result.reason).toBe('similar mistake seen 4 times');
  });

  // -------------------------------------------------------------------------
  // 9b. Custom thresholds {warn:3, block:8}: occurrences=8 → BLOCK
  // -------------------------------------------------------------------------
  it('returns BLOCK with custom thresholds when occurrences=8, warn=3, block=8', () => {
    const { recognizer } = makeRecognizer(() => [makePattern('custom002', 8)]);
    const guard = new MistakeAutoBlockGuard({
      patternRecognizer: recognizer,
      thresholds: { warnOccurrences: 3, blockOccurrences: 8, windowDays: 14 },
    });
    const result = guard.check('action with custom block threshold');
    expect(result.verdict).toBe('BLOCK');
    expect(result.reason).toContain('8 times');
  });

  // -------------------------------------------------------------------------
  // 10. Recognizer throws → PASS (fail-open)
  // -------------------------------------------------------------------------
  it('returns PASS when recognizer throws (fail-open)', () => {
    const { recognizer } = makeRecognizer(() => {
      throw new Error('DB connection failed');
    });
    const guard = new MistakeAutoBlockGuard({ patternRecognizer: recognizer });
    const result = guard.check('some candidate text');
    expect(result.verdict).toBe('PASS');
    expect(result.reason).toBe('guard unavailable');
    expect(result.matchedPatternCount).toBe(0);
    expect(result.topPattern).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 11. matchedPatternCount accurate across multiple matches
  // -------------------------------------------------------------------------
  it('reports accurate matchedPatternCount for 4 returned patterns', () => {
    const patterns = [
      makePattern('p1', 1),
      makePattern('p2', 2),
      makePattern('p3', 3),
      makePattern('p4', 4),
    ];
    const { recognizer } = makeRecognizer(() => patterns);
    const guard = new MistakeAutoBlockGuard({ patternRecognizer: recognizer });
    const result = guard.check('multi-pattern candidate');
    // top=p4 occurrences=4, default block=5, so WARN (>= warn=2)
    expect(result.matchedPatternCount).toBe(4);
    expect(result.verdict).toBe('WARN');
  });

  // -------------------------------------------------------------------------
  // 12. windowDays forwarded to recognizer.findSimilar (spy check)
  // -------------------------------------------------------------------------
  it('forwards windowDays to recognizer.findSimilar', () => {
    const { recognizer, spy } = makeRecognizer(() => []);
    const guard = new MistakeAutoBlockGuard({
      patternRecognizer: recognizer,
      thresholds: { windowDays: 14 },
    });
    guard.check('any valid text here');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith('any valid text here', { windowDays: 14 });
  });

  // -------------------------------------------------------------------------
  // Bonus: checkedAt is always a valid ISO string
  // -------------------------------------------------------------------------
  it('returns a valid ISO checkedAt timestamp in every result', () => {
    const { recognizer } = makeRecognizer(() => []);
    const guard = new MistakeAutoBlockGuard({ patternRecognizer: recognizer });
    const before = Date.now();
    const result = guard.check('timestamp test');
    const after = Date.now();
    const ts = new Date(result.checkedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
