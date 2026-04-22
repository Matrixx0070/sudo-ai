/**
 * @file cognition/mistake-auto-block-guard.ts
 * @description MistakeAutoBlockGuard — pure stateless wrapper around
 * MistakePatternRecognizer.findSimilar that returns a verdict (PASS/WARN/BLOCK)
 * for a candidate action description before it is executed.
 *
 * Pure module — no DB writes, no persistence, no side effects.
 * 6R will wire this into the veto-gate / agent loop.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('cognition:mistake-auto-block-guard');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type BlockVerdict = 'PASS' | 'WARN' | 'BLOCK';

export interface GuardDecision {
  verdict: BlockVerdict;
  reason: string;
  matchedPatternCount: number;
  topPattern?: { signatureHash: string; occurrences: number };
  checkedAt: string;
}

export interface GuardThresholds {
  warnOccurrences: number;   // default 2
  blockOccurrences: number;  // default 5
  windowDays: number;        // default 7
}

// ---------------------------------------------------------------------------
// Default thresholds
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS: Readonly<GuardThresholds> = {
  warnOccurrences: 2,
  blockOccurrences: 5,
  windowDays: 7,
};

// ---------------------------------------------------------------------------
// Duck-typed interface for the pattern recognizer dependency
// ---------------------------------------------------------------------------

export interface PatternRecognizerLike {
  findSimilar(
    text: string,
    opts?: { windowDays?: number },
  ): Array<{ signatureHash: string; occurrences: number; [k: string]: unknown }>;
}

// ---------------------------------------------------------------------------
// MistakeAutoBlockGuard
// ---------------------------------------------------------------------------

export class MistakeAutoBlockGuard {
  private readonly _recognizer: PatternRecognizerLike;
  private readonly _thresholds: Readonly<GuardThresholds>;

  constructor(opts: {
    patternRecognizer: PatternRecognizerLike;
    thresholds?: Partial<GuardThresholds>;
  }) {
    if (!opts.patternRecognizer) {
      throw new Error('MistakeAutoBlockGuard: patternRecognizer is required');
    }
    this._recognizer = opts.patternRecognizer;
    this._thresholds = {
      warnOccurrences:
        opts.thresholds?.warnOccurrences ?? DEFAULT_THRESHOLDS.warnOccurrences,
      blockOccurrences:
        opts.thresholds?.blockOccurrences ?? DEFAULT_THRESHOLDS.blockOccurrences,
      windowDays:
        opts.thresholds?.windowDays ?? DEFAULT_THRESHOLDS.windowDays,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Check a candidate action description against known mistake patterns.
   *
   * Behavior:
   * - Empty/whitespace input → PASS ('empty input')
   * - No matching patterns → PASS ('no matching patterns')
   * - Top pattern occurrences >= blockOccurrences → BLOCK
   * - Top pattern occurrences >= warnOccurrences → WARN
   * - Otherwise → PASS
   * - Recognizer throws → PASS ('guard unavailable') — fail-open, never block on error
   */
  check(candidateText: string): GuardDecision {
    const checkedAt = new Date().toISOString();
    const { warnOccurrences, blockOccurrences, windowDays } = this._thresholds;

    // Guard: empty / whitespace input
    if (typeof candidateText !== 'string' || candidateText.trim().length === 0) {
      log.debug(
        { event: 'guard.check.empty', checkedAt },
        'mistake-auto-block-guard: empty input, returning PASS',
      );
      return {
        verdict: 'PASS',
        reason: 'empty input',
        matchedPatternCount: 0,
        checkedAt,
      };
    }

    // Query the recognizer — fail-open on any error
    let patterns: Array<{ signatureHash: string; occurrences: number; [k: string]: unknown }>;
    try {
      patterns = this._recognizer.findSimilar(candidateText, { windowDays });
    } catch (err: unknown) {
      log.warn(
        { err, event: 'guard.check.recognizer-error', checkedAt },
        'mistake-auto-block-guard: recognizer threw, returning PASS (fail-open)',
      );
      return {
        verdict: 'PASS',
        reason: 'guard unavailable',
        matchedPatternCount: 0,
        checkedAt,
      };
    }

    // No matching patterns
    if (!Array.isArray(patterns) || patterns.length === 0) {
      log.debug(
        { event: 'guard.check.no-patterns', checkedAt },
        'mistake-auto-block-guard: no matching patterns, returning PASS',
      );
      return {
        verdict: 'PASS',
        reason: 'no matching patterns',
        matchedPatternCount: 0,
        checkedAt,
      };
    }

    const matchedPatternCount = patterns.length;

    // Find top pattern by highest occurrence count
    const top = patterns.reduce(
      (best, p) => (p.occurrences > best.occurrences ? p : best),
      patterns[0],
    );

    const topPattern = { signatureHash: top.signatureHash, occurrences: top.occurrences };

    // Evaluate verdict
    if (top.occurrences >= blockOccurrences) {
      const reason =
        `recurring mistake pattern matched ${top.occurrences} times in ${windowDays} days`;
      log.warn(
        {
          event: 'guard.check.block',
          occurrences: top.occurrences,
          signatureHash: top.signatureHash,
          matchedPatternCount,
          checkedAt,
        },
        `mistake-auto-block-guard: BLOCK — ${reason}`,
      );
      return { verdict: 'BLOCK', reason, matchedPatternCount, topPattern, checkedAt };
    }

    if (top.occurrences >= warnOccurrences) {
      const reason = `similar mistake seen ${top.occurrences} times`;
      log.info(
        {
          event: 'guard.check.warn',
          occurrences: top.occurrences,
          signatureHash: top.signatureHash,
          matchedPatternCount,
          checkedAt,
        },
        `mistake-auto-block-guard: WARN — ${reason}`,
      );
      return { verdict: 'WARN', reason, matchedPatternCount, topPattern, checkedAt };
    }

    // Below warn threshold — PASS
    log.debug(
      {
        event: 'guard.check.pass',
        occurrences: top.occurrences,
        matchedPatternCount,
        checkedAt,
      },
      'mistake-auto-block-guard: below warn threshold, returning PASS',
    );
    return { verdict: 'PASS', reason: 'below warning threshold', matchedPatternCount, topPattern, checkedAt };
  }
}
