/**
 * @file tests/consciousness/world-model-prior.test.ts
 * @description Closing the world-model learning loop: the `tool_use` confidence
 * prior is now seeded from the LEARNED empirical match rate (via
 * getDomainMatchRate) once enough outcomes resolve, instead of the fixed
 * 0.35/0.75 message-length heuristic that made confidence oscillate every turn.
 *
 * Two layers:
 *   1. computeToolUsePrior — pure: cold-start fallback, length nudge, clamping.
 *   2. End-to-end: recording outcomes moves getDomainMatchRate, and the prior
 *      tracks it (convergence) rather than staying stuck at the heuristic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsciousnessDB } from '../../src/core/consciousness/consciousness-db.js';
import { WorldModel } from '../../src/core/consciousness/world-model/index.js';
import {
  computeToolUsePrior,
  TOOL_USE_PRIOR_MIN_SAMPLES,
} from '../../src/core/consciousness/world-model/index.js';

const SHORT = 'hi'.length;        // 2 chars  → short branch
const LONG = 'x'.repeat(200).length; // 200 chars → long branch

describe('computeToolUsePrior (pure)', () => {
  it('PRIOR-1: cold start (too few samples) falls back to the length heuristic', () => {
    for (let resolved = 0; resolved < TOOL_USE_PRIOR_MIN_SAMPLES; resolved++) {
      expect(computeToolUsePrior(SHORT, 0.9, resolved)).toBe(0.35);
      expect(computeToolUsePrior(LONG, 0.1, resolved)).toBe(0.75);
    }
  });

  it('PRIOR-2: with evidence, anchors on the base rate + length nudge', () => {
    // High learned tool-use rate → even a SHORT message now predicts high use,
    // the opposite of the old stuck 0.35.
    expect(computeToolUsePrior(SHORT, 0.9, 10)).toBeCloseTo(0.8, 5);  // 0.9 - 0.1
    expect(computeToolUsePrior(LONG, 0.9, 10)).toBeCloseTo(0.95, 5);  // 0.9 + 0.1 → clamp 0.95
    // Low learned rate → even a LONG message now predicts low use (was stuck 0.75).
    expect(computeToolUsePrior(LONG, 0.1, 10)).toBeCloseTo(0.2, 5);   // 0.1 + 0.1
    expect(computeToolUsePrior(SHORT, 0.1, 10)).toBeCloseTo(0.05, 5); // 0.1 - 0.1 → clamp 0.05
  });

  it('PRIOR-3: clamps to [0.05, 0.95] and tolerates a non-finite base rate', () => {
    expect(computeToolUsePrior(LONG, 1.0, 50)).toBe(0.95);
    expect(computeToolUsePrior(SHORT, 0.0, 50)).toBe(0.05);
    expect(computeToolUsePrior(SHORT, Number.NaN, 50)).toBe(0.35); // falls back to heuristic
  });
});

describe('world-model learned prior — end-to-end convergence', () => {
  let tempDir: string;
  let cdb: ConsciousnessDB;
  let wm: WorldModel;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wmp-test-'));
    cdb = new ConsciousnessDB(join(tempDir, 'c.db'));
    wm = new WorldModel(cdb);
  });
  afterEach(() => {
    try { cdb.getDb().close(); } catch { /* ignore */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function record(matched: boolean): void {
    const e = wm.predict('tool_use', 'this interaction will require tool use', 0.5);
    wm.save(e);
    wm.recordOutcome(e.id, matched ? 'used tools' : 'answered directly', matched);
  }

  it('PRIOR-4: fresh model has no evidence → match rate 0.5, prior = cold-start heuristic', () => {
    const { rate, resolved } = wm.getDomainMatchRate('tool_use');
    expect(resolved).toBe(0);
    expect(rate).toBe(0.5);
    expect(computeToolUsePrior(SHORT, rate, resolved)).toBe(0.35);
  });

  it('PRIOR-5: after a tool-heavy history, a SHORT message no longer predicts 0.35', () => {
    for (let i = 0; i < 8; i++) record(true);   // tools used 8/8
    const { rate, resolved } = wm.getDomainMatchRate('tool_use');
    expect(resolved).toBe(8);
    expect(rate).toBeCloseTo(1.0, 5);
    const prior = computeToolUsePrior(SHORT, rate, resolved);
    expect(prior).toBeCloseTo(0.9, 5);          // 1.0 - 0.1 nudge
    expect(prior).toBeGreaterThan(0.35);        // the loop is closed: history moved it
  });

  it('PRIOR-6: a tool-light history pulls the prior down, tracking the true rate', () => {
    record(true);
    for (let i = 0; i < 9; i++) record(false);  // tools used 1/10 = 0.1
    const { rate, resolved } = wm.getDomainMatchRate('tool_use');
    expect(resolved).toBe(10);
    expect(rate).toBeCloseTo(0.1, 5);
    const prior = computeToolUsePrior(LONG, rate, resolved);
    expect(prior).toBeCloseTo(0.2, 5);          // 0.1 + 0.1 nudge
    expect(prior).toBeLessThan(0.75);           // was stuck at 0.75 before the fix
  });
});
