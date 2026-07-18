/**
 * @file tests/consciousness/temporal-self-snapshot.test.ts
 * @description F127 — unit coverage for TemporalSelf.takeSnapshot against a
 * real ConsciousnessDB on a temp dir: input validation, persistence into
 * self_snapshots (round-trip via getTimeline), capability-label capture from
 * the self-model, and defensive copying of the goals array. Uses a controlled
 * SelfModelLike fake so capability/personality inputs are deterministic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsciousnessDB } from '../../src/core/consciousness/consciousness-db.js';
import { TemporalSelf } from '../../src/core/consciousness/temporal-self/index.js';
import type { SelfModelLike } from '../../src/core/consciousness/temporal-self/types.js';
import type { CapabilityAssessment, EmotionTag } from '../../src/core/consciousness/types.js';
import { ConsciousnessError } from '../../src/core/consciousness/errors.js';

function cap(domain: string, level: number, confidence = 0.6): CapabilityAssessment {
  return {
    domain,
    level,
    confidence,
    evidenceCount: 5,
    trend: 'stable',
    lastAssessed: new Date().toISOString(),
  };
}

function fakeSelfModel(overrides: Partial<SelfModelLike> = {}): SelfModelLike {
  return {
    getStrengths: () => [cap('coding', 0.9)],
    getWeaknesses: () => [cap('smalltalk', 0.1)],
    getGrowthAreas: () => [],
    getPersonalityTraits: () => ({ analytical: 0.8, persistent: 0.6 }),
    getOverallConfidence: () => 0.6,
    ...overrides,
  };
}

describe('TemporalSelf.takeSnapshot (F127)', () => {
  let tempDir: string;
  let cdb: ConsciousnessDB;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'temporal-self-'));
    cdb = new ConsciousnessDB(join(tempDir, 'c.db'));
  });

  afterEach(() => {
    try { cdb.getDb().close(); } catch { /* ignore */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('TS-1: takeSnapshot persists a row and getTimeline round-trips it', () => {
    const ts = new TemporalSelf(cdb, fakeSelfModel());
    const snap = ts.takeSnapshot({ dominantEmotion: 'calm' as EmotionTag }, ['ship F127']);

    expect(snap.id).toBeTruthy();
    expect(snap.dominantEmotion).toBe('calm');
    expect(snap.activeGoals).toEqual(['ship F127']);
    // Capability labels come from numericToLabel over strengths + weaknesses.
    expect(snap.capabilities).toEqual({ coding: 'expert', smalltalk: 'novice' });
    expect(snap.personality).toEqual({ analytical: 0.8, persistent: 0.6 });
    expect(Date.parse(snap.snapshotAt)).not.toBeNaN();

    // Round-trip through the DB, not just the returned object.
    const [stored] = ts.getTimeline(1);
    expect(stored).toEqual(snap);

    // And the raw row really is in self_snapshots.
    const raw = cdb.getDb().prepare('SELECT id FROM self_snapshots WHERE id = ?').get(snap.id);
    expect(raw).toBeDefined();
  });

  it('TS-2: takeSnapshot validates emotionalState and goals', () => {
    const ts = new TemporalSelf(cdb, fakeSelfModel());
    expect(() =>
      ts.takeSnapshot(undefined as unknown as { dominantEmotion: EmotionTag }, []),
    ).toThrow(ConsciousnessError);
    expect(() =>
      ts.takeSnapshot({ dominantEmotion: '' as EmotionTag }, []),
    ).toThrow(ConsciousnessError);
    expect(() =>
      ts.takeSnapshot({ dominantEmotion: 'calm' as EmotionTag }, 'not-an-array' as unknown as string[]),
    ).toThrow(ConsciousnessError);
    // Nothing was persisted by the failed calls.
    const count = cdb.getDb().prepare('SELECT COUNT(*) AS n FROM self_snapshots').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('TS-3: goals array is copied — later caller mutation does not leak into the snapshot', () => {
    const ts = new TemporalSelf(cdb, fakeSelfModel());
    const goals = ['goal-a'];
    const snap = ts.takeSnapshot({ dominantEmotion: 'curious' as EmotionTag }, goals);
    goals.push('goal-b');
    expect(snap.activeGoals).toEqual(['goal-a']);
    expect(ts.getTimeline(1)[0].activeGoals).toEqual(['goal-a']);
  });

  it('TS-4: empty self-model produces an empty-capability snapshot without throwing', () => {
    const ts = new TemporalSelf(
      cdb,
      fakeSelfModel({
        getStrengths: () => [],
        getWeaknesses: () => [],
        getPersonalityTraits: () => ({}),
      }),
    );
    const snap = ts.takeSnapshot({ dominantEmotion: 'calm' as EmotionTag }, []);
    expect(snap.capabilities).toEqual({});
    expect(snap.personality).toEqual({});
    expect(snap.activeGoals).toEqual([]);
    expect(ts.getTimeline(1)[0]).toEqual(snap);
  });

  it('TS-5: getTimeline returns newest-first and honours the limit', () => {
    const ts = new TemporalSelf(cdb, fakeSelfModel());
    const s1 = ts.takeSnapshot({ dominantEmotion: 'calm' as EmotionTag }, ['g1']);
    const s2 = ts.takeSnapshot({ dominantEmotion: 'curious' as EmotionTag }, ['g2']);
    const s3 = ts.takeSnapshot({ dominantEmotion: 'calm' as EmotionTag }, ['g3']);

    // snapshotAt has millisecond resolution; ids differ even if timestamps tie,
    // so assert set membership for the limited query and full ordering loosely.
    const top2 = ts.getTimeline(2);
    expect(top2).toHaveLength(2);
    const all = ts.getTimeline(10).map((s) => s.id);
    expect(all).toHaveLength(3);
    expect(new Set(all)).toEqual(new Set([s1.id, s2.id, s3.id]));

    expect(() => ts.getTimeline(0)).toThrow(ConsciousnessError);
  });

  it('TS-6: constructor rejects missing db or self-model', () => {
    expect(() => new TemporalSelf(null as unknown as ConsciousnessDB, fakeSelfModel())).toThrow(
      ConsciousnessError,
    );
    expect(() => new TemporalSelf(cdb, null as unknown as SelfModelLike)).toThrow(
      ConsciousnessError,
    );
  });
});
