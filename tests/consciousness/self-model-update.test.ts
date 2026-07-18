/**
 * @file tests/consciousness/self-model-update.test.ts
 * @description F127 — unit coverage for SelfModel.updateFromEpisode against a
 * real ConsciousnessDB on a temp dir: capability upsert (counters, confidence
 * drift, level from success ratio, trend), personality observations written
 * per episode, and input validation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsciousnessDB } from '../../src/core/consciousness/consciousness-db.js';
import { SelfModel } from '../../src/core/consciousness/self-model/index.js';
import type { EpisodeLike } from '../../src/core/consciousness/self-model/types.js';
import { ConsciousnessError } from '../../src/core/consciousness/errors.js';

let idc = 0;
function ep(overrides: Partial<EpisodeLike> = {}): EpisodeLike {
  idc += 1;
  return {
    id: `ep-${idc}`,
    topic: 'coding',
    outcome: 'positive',
    significance: 0.5,
    ...overrides,
  };
}

interface CapRow {
  domain: string;
  level: string;
  confidence: number;
  evidence_count: number;
  success_count: number;
  failure_count: number;
  trend: string;
  last_assessed: string;
}

describe('SelfModel.updateFromEpisode (F127)', () => {
  let tempDir: string;
  let cdb: ConsciousnessDB;
  let sm: SelfModel;

  const capRow = (domain: string): CapRow | undefined =>
    cdb.getDb().prepare('SELECT * FROM capability_assessments WHERE domain = ?').get(domain) as
      | CapRow
      | undefined;

  beforeEach(() => {
    idc = 0;
    tempDir = mkdtempSync(join(tmpdir(), 'self-model-'));
    cdb = new ConsciousnessDB(join(tempDir, 'c.db'));
    sm = new SelfModel(cdb);
  });

  afterEach(() => {
    try { cdb.getDb().close(); } catch { /* ignore */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('SM-1: first positive episode creates a capability row with the right counters', () => {
    sm.updateFromEpisode(ep({ topic: 'coding', outcome: 'positive' }));

    const row = capRow('coding');
    expect(row).toBeDefined();
    expect(row!.evidence_count).toBe(1);
    expect(row!.success_count).toBe(1);
    expect(row!.failure_count).toBe(0);
    // Baseline confidence 0.5 + 0.05 for a positive outcome.
    expect(row!.confidence).toBeCloseTo(0.55, 6);
    // 1/1 success ratio → expert band.
    expect(row!.level).toBe('expert');
    expect(row!.trend).toBe('stable'); // < 10 evidence → stable
  });

  it('SM-2: negative episode decrements confidence and counts a failure', () => {
    sm.updateFromEpisode(ep({ topic: 'ops', outcome: 'negative' }));
    const row = capRow('ops');
    expect(row!.failure_count).toBe(1);
    expect(row!.success_count).toBe(0);
    expect(row!.confidence).toBeCloseTo(0.45, 6);
    // 0/1 success ratio → novice band.
    expect(row!.level).toBe('novice');
  });

  it('SM-3: neutral episode adds evidence but no success/failure or confidence drift', () => {
    sm.updateFromEpisode(ep({ topic: 'chat', outcome: 'neutral' }));
    const row = capRow('chat');
    expect(row!.evidence_count).toBe(1);
    expect(row!.success_count).toBe(0);
    expect(row!.failure_count).toBe(0);
    expect(row!.confidence).toBeCloseTo(0.5, 6);
    // 0 successes + 0 failures → ratio defaults to 0.5 → competent band.
    expect(row!.level).toBe('competent');
  });

  it('SM-4: repeated episodes accumulate — 12 positives turn the trend improving', () => {
    for (let i = 0; i < 12; i++) {
      sm.updateFromEpisode(ep({ topic: 'coding', outcome: 'positive' }));
    }
    const row = capRow('coding');
    expect(row!.evidence_count).toBe(12);
    expect(row!.success_count).toBe(12);
    expect(row!.level).toBe('expert');
    expect(row!.trend).toBe('improving'); // >= 10 evidence, success rate > 0.6
    // Confidence caps at 1.0 (0.5 + 12×0.05 clamped).
    expect(row!.confidence).toBe(1);
  });

  it('SM-5: mostly failures over 10+ episodes → declining trend, floor confidence 0.1', () => {
    for (let i = 0; i < 12; i++) {
      sm.updateFromEpisode(ep({ topic: 'flaky', outcome: 'negative' }));
    }
    const row = capRow('flaky');
    expect(row!.trend).toBe('declining');
    expect(row!.level).toBe('novice');
    // Confidence is floored at 0.1, never 0.
    expect(row!.confidence).toBeCloseTo(0.1, 6);
  });

  it('SM-6: personality observations are persisted per episode with the episode source', () => {
    const e = ep({ topic: 'debugging the parser', outcome: 'positive', significance: 0.9 });
    sm.updateFromEpisode(e);

    const obs = cdb
      .getDb()
      .prepare('SELECT trait, value, source FROM personality_observations ORDER BY trait')
      .all() as Array<{ trait: string; value: number; source: string }>;

    const traits = obs.map((o) => o.trait);
    // topic matches /debug/ → analytical; positive → confident; high significance → ambitious.
    expect(traits).toContain('analytical');
    expect(traits).toContain('confident');
    expect(traits).toContain('ambitious');
    for (const o of obs) {
      expect(o.source).toBe(`episode:${e.id}`);
      expect(o.value).toBeGreaterThanOrEqual(0);
      expect(o.value).toBeLessThanOrEqual(1);
    }
  });

  it('SM-7: getStrengths/getWeaknesses reflect updates through the store', () => {
    for (let i = 0; i < 3; i++) sm.updateFromEpisode(ep({ topic: 'strong-suit', outcome: 'positive' }));
    for (let i = 0; i < 3; i++) sm.updateFromEpisode(ep({ topic: 'weak-spot', outcome: 'negative' }));

    const strengths = sm.getStrengths(5).map((s) => s.domain);
    const weaknesses = sm.getWeaknesses(5).map((w) => w.domain);
    expect(strengths).toContain('strong-suit');
    expect(strengths).not.toContain('weak-spot');
    expect(weaknesses).toContain('weak-spot');
    expect(weaknesses).not.toContain('strong-suit');
  });

  it('SM-8: updateFromEpisode rejects a missing/topic-less episode', () => {
    expect(() => sm.updateFromEpisode(null as unknown as EpisodeLike)).toThrow(ConsciousnessError);
    expect(() => sm.updateFromEpisode(ep({ topic: '' }))).toThrow(ConsciousnessError);
    const count = cdb.getDb().prepare('SELECT COUNT(*) AS n FROM capability_assessments').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('SM-9: getOverallConfidence averages stored assessments (0.5 baseline when empty)', () => {
    expect(sm.getOverallConfidence()).toBe(0.5);
    sm.updateFromEpisode(ep({ topic: 'a', outcome: 'positive' })); // 0.55
    sm.updateFromEpisode(ep({ topic: 'b', outcome: 'negative' })); // 0.45
    expect(sm.getOverallConfidence()).toBeCloseTo(0.5, 3);
  });
});
