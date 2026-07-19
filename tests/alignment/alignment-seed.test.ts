/**
 * F108 slice 1 — alignment seeding.
 *
 * The AlignmentAggregator is null-reporting (warming-up) until a live turn calls
 * evaluate(); that made SUDO_SELF_BUILD_MIN_ALIGN_SCORE gate against nothing.
 * seedAlignmentAggregator() reads the operator identity anchor READ-ONLY and
 * runs one evaluate() so the gate has a real, evaluable baseline from boot.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlignmentAggregator } from '../../src/core/agent/alignment-aggregator.js';
import type { IdentityAnchor } from '../../src/core/identity/types.js';
import {
  deriveSeedSignals,
  seedAlignmentAggregator,
  anchorPresent,
  HEALTHY_SEED,
  DEGRADED_SEED,
} from '../../src/core/agent/alignment-seed.js';

const PRESENT: IdentityAnchor = { identity: 'I am the operator agent.', values: { loyalty: 'owner' }, prohibitions: null };
const ABSENT: IdentityAnchor = { identity: null, values: null, prohibitions: null };

describe('F108 deriveSeedSignals', () => {
  it('returns the healthy baseline when the identity anchor is present', () => {
    expect(anchorPresent(PRESENT)).toBe(true);
    expect(deriveSeedSignals(PRESENT)).toEqual(HEALTHY_SEED);
  });

  it('returns the degraded baseline when the anchor is absent or null', () => {
    expect(anchorPresent(ABSENT)).toBe(false);
    expect(anchorPresent(null)).toBe(false);
    expect(deriveSeedSignals(ABSENT)).toEqual(DEGRADED_SEED);
    expect(deriveSeedSignals(null)).toEqual(DEGRADED_SEED);
  });
});

describe('F108 seed baseline scores (real aggregator)', () => {
  it('healthy anchor seeds a GREEN score that passes the default 0.6 min-align gate', () => {
    const agg = new AlignmentAggregator();
    const res = agg.evaluate(deriveSeedSignals(PRESENT));
    expect(res.level).toBe('GREEN');
    expect(res.score).toBeGreaterThanOrEqual(0.6);
  });

  it('absent anchor seeds a sub-0.6 score so the gate fails closed', () => {
    const agg = new AlignmentAggregator();
    const res = agg.evaluate(deriveSeedSignals(ABSENT));
    expect(res.score).toBeLessThan(0.6);
    expect(res.level).not.toBe('GREEN');
  });
});

describe('F108 seedAlignmentAggregator wiring', () => {
  let dir: string;
  const savedIdentityDir = process.env['SUDO_IDENTITY_DIR'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'f108-ident-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedIdentityDir === undefined) delete process.env['SUDO_IDENTITY_DIR'];
    else process.env['SUDO_IDENTITY_DIR'] = savedIdentityDir;
  });

  it('unseeded aggregator reports null (warming-up); seeding makes the score evaluable', () => {
    const agg = new AlignmentAggregator();
    // Before seeding: warm-up state — the gate has nothing to evaluate.
    expect(agg.getLastReport()).toBeNull();

    writeFileSync(join(dir, 'core-identity.md'), '# Operator identity\nOwner-loyal agent.');
    const outcome = seedAlignmentAggregator(agg, { configDir: dir });

    expect(outcome.seeded).toBe(true);
    expect(outcome.anchorPresent).toBe(true);
    expect(outcome.level).toBe('GREEN');
    // After seeding: getLastReport() is non-null — the min-align gate evaluates.
    const report = agg.getLastReport();
    expect(report).not.toBeNull();
    expect((report as { score: number }).score).toBeGreaterThanOrEqual(0.6);
  });

  it('seeds a degraded baseline when the identity dir has no anchor files', () => {
    const agg = new AlignmentAggregator();
    const outcome = seedAlignmentAggregator(agg, { configDir: dir });
    expect(outcome.seeded).toBe(true);
    expect(outcome.anchorPresent).toBe(false);
    expect(outcome.score).not.toBeNull();
    expect(outcome.score as number).toBeLessThan(0.6);
  });

  it('is a no-op (no throw) when the aggregator is null/undefined', () => {
    expect(() => seedAlignmentAggregator(null, { configDir: dir })).not.toThrow();
    expect(seedAlignmentAggregator(undefined).seeded).toBe(false);
  });
});
