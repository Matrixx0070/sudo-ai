/**
 * @file tests/consciousness/episodic-store.test.ts
 * @description F127 — unit coverage for the episodic-memory store backing
 * consciousness.db: save (insert + idempotent upsert + field coercion),
 * dedup (opt-in recurrence suppression), getBySignificance ordering,
 * and strengthen/weaken round-trips (cap 1.0 / floor 0, missing-id no-op).
 * Uses a real ConsciousnessDB on a temp dir, per the established pattern
 * in tests/consciousness/episodic-dedup.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsciousnessDB } from '../../src/core/consciousness/consciousness-db.js';
import { EpisodicMemory } from '../../src/core/consciousness/episodic-memory/index.js';
import type { Episode } from '../../src/core/consciousness/episodic-memory/types.js';
import { ConsciousnessError } from '../../src/core/consciousness/errors.js';

let idc = 0;
function ep(overrides: Partial<Episode> = {}): Episode {
  idc += 1;
  const now = new Date().toISOString();
  return {
    id: `ep-${idc}`,
    summary: `summary ${idc}`,
    participants: ['user-1'],
    topic: 'testing',
    tags: [],
    emotionalValence: { tags: ['calm'], dominantEmotion: 'calm', intensity: 0.3 },
    surpriseLevel: 0,
    outcome: 'neutral',
    significance: 0.5,
    sessionId: 's1',
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    ...overrides,
  };
}

describe('EpisodicMemory store (F127)', () => {
  let tempDir: string;
  let cdb: ConsciousnessDB;
  let em: EpisodicMemory;

  beforeEach(() => {
    idc = 0;
    tempDir = mkdtempSync(join(tmpdir(), 'episodic-store-'));
    cdb = new ConsciousnessDB(join(tempDir, 'c.db'));
    em = new EpisodicMemory(cdb);
  });

  afterEach(() => {
    delete process.env.SUDO_EPISODIC_DEDUP;
    delete process.env.SUDO_EPISODIC_DEDUP_WINDOW_MS;
    try { cdb.getDb().close(); } catch { /* ignore */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // save / round-trip
  // -------------------------------------------------------------------------

  it('EPS-1: recordEpisode round-trips every field through the DB', () => {
    const e = ep({
      summary: 'built the widget',
      topic: 'widgets',
      tags: ['build', 'ship'],
      participants: ['frank'],
      outcome: 'positive',
      significance: 0.8,
      surpriseLevel: 0.2,
      durationMs: 1234,
    });
    em.recordEpisode(e);

    const [stored] = em.getRecent(1);
    expect(stored).toBeDefined();
    expect(stored.id).toBe(e.id);
    expect(stored.summary).toBe('built the widget');
    expect(stored.topic).toBe('widgets');
    expect(stored.tags).toEqual(['build', 'ship']);
    expect(stored.participants).toEqual(['frank']);
    expect(stored.outcome).toBe('positive');
    expect(stored.significance).toBeCloseTo(0.8, 6);
    expect(stored.surpriseLevel).toBeCloseTo(0.2, 6);
    expect(stored.durationMs).toBe(1234);
    expect(stored.sessionId).toBe('s1');
  });

  it('EPS-2: re-inserting the same id is an idempotent upsert, not a throw', () => {
    const e = ep({ significance: 0.4, summary: 'first pass' });
    em.recordEpisode(e);
    // At-least-once recorder retries with the same id and a higher significance.
    em.recordEpisode({ ...e, summary: 'second pass', significance: 0.7 });

    const all = em.getRecent(10);
    expect(all).toHaveLength(1);
    expect(all[0].summary).toBe('second pass');
    // ON CONFLICT keeps MAX(significance)
    expect(all[0].significance).toBeCloseTo(0.7, 6);

    // Lower significance on retry never downgrades the stored row.
    em.recordEpisode({ ...e, summary: 'third pass', significance: 0.1 });
    expect(em.getRecent(10)[0].significance).toBeCloseTo(0.7, 6);
  });

  it('EPS-3: partially-constructed episode persists with coerced defaults', () => {
    const now = new Date().toISOString();
    // Only the required fields; everything else undefined/invalid.
    const partial = {
      id: 'partial-1',
      summary: 'crash-recovered episode',
      startedAt: now,
      endedAt: now,
    } as unknown as Episode;
    em.recordEpisode(partial);

    const [stored] = em.getRecent(1);
    expect(stored.id).toBe('partial-1');
    expect(stored.outcome).toBe('neutral');       // invalid outcome → 'neutral'
    expect(stored.significance).toBeCloseTo(0.5); // NaN → 0.5 default
    expect(stored.surpriseLevel).toBe(0);
    expect(stored.tags).toEqual([]);
    expect(stored.participants).toEqual([]);
    expect(stored.sessionId).toBeNull();
    expect(stored.durationMs).toBe(0);
  });

  it('EPS-4: recordEpisode rejects missing id/summary/timestamps', () => {
    expect(() => em.recordEpisode(null as unknown as Episode)).toThrow(ConsciousnessError);
    expect(() => em.recordEpisode(ep({ id: '' }))).toThrow(ConsciousnessError);
    expect(() => em.recordEpisode(ep({ summary: '   ' }))).toThrow(ConsciousnessError);
    expect(() => em.recordEpisode(ep({ startedAt: '' }))).toThrow(ConsciousnessError);
    expect(() => em.recordEpisode(ep({ endedAt: '' }))).toThrow(ConsciousnessError);
    expect(em.getRecent(10)).toHaveLength(0);
  });

  it('EPS-5: significance outside [0,1] is clamped on save', () => {
    em.recordEpisode(ep({ id: 'hot', significance: 5 }));
    em.recordEpisode(ep({ id: 'cold', significance: -3 }));
    const byId = new Map(em.getRecent(10).map((e) => [e.id, e]));
    expect(byId.get('hot')?.significance).toBe(1);
    expect(byId.get('cold')?.significance).toBe(0);
  });

  // -------------------------------------------------------------------------
  // dedup
  // -------------------------------------------------------------------------

  it('EPS-6: dedup is OFF by default — identical summaries accumulate', () => {
    const HB = '[HEARTBEAT] no change';
    for (let i = 0; i < 5; i++) em.recordEpisode(ep({ summary: HB }));
    expect(em.getRecent(10)).toHaveLength(5);
  });

  it('EPS-7: SUDO_EPISODIC_DEDUP=1 collapses recurrences and strengthens the survivor', () => {
    process.env.SUDO_EPISODIC_DEDUP = '1';
    const HB = '[HEARTBEAT] no change';
    const first = ep({ summary: HB, significance: 0.5 });
    em.recordEpisode(first);
    for (let i = 0; i < 4; i++) em.recordEpisode(ep({ summary: HB, significance: 0.5 }));

    const all = em.getRecent(10);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(first.id);
    // 4 suppressed recurrences × DEDUP_STRENGTHEN_DELTA (0.02)
    expect(all[0].significance).toBeCloseTo(0.58, 6);
  });

  it('EPS-8: dedup only matches within the window — old duplicates re-insert', () => {
    process.env.SUDO_EPISODIC_DEDUP = '1';
    process.env.SUDO_EPISODIC_DEDUP_WINDOW_MS = '1000'; // 1s window
    const HB = '[HEARTBEAT] stale';
    const old = new Date(Date.now() - 60_000).toISOString();
    em.recordEpisode(ep({ summary: HB, startedAt: old, endedAt: old }));
    // New episode starts now; the prior one is outside the 1s window.
    em.recordEpisode(ep({ summary: HB }));
    expect(em.getRecent(10)).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // getBySignificance
  // -------------------------------------------------------------------------

  it('EPS-9: getBySignificance returns rows ordered by significance DESC, limited', () => {
    em.recordEpisode(ep({ id: 'low', significance: 0.1 }));
    em.recordEpisode(ep({ id: 'high', significance: 0.9 }));
    em.recordEpisode(ep({ id: 'mid', significance: 0.5 }));

    const top2 = em.getBySignificance(2);
    expect(top2.map((e) => e.id)).toEqual(['high', 'mid']);

    const all = em.getBySignificance(10);
    expect(all.map((e) => e.id)).toEqual(['high', 'mid', 'low']);
  });

  it('EPS-10: getBySignificance / getRecent reject non-positive counts', () => {
    expect(() => em.getBySignificance(0)).toThrow(ConsciousnessError);
    expect(() => em.getBySignificance(1.5)).toThrow(ConsciousnessError);
    expect(() => em.getRecent(-1)).toThrow(ConsciousnessError);
  });

  // -------------------------------------------------------------------------
  // strengthen / weaken
  // -------------------------------------------------------------------------

  it('EPS-11: strengthenEpisode adds delta and caps at 1.0', () => {
    const e = ep({ significance: 0.9 });
    em.recordEpisode(e);
    em.strengthenEpisode(e.id, 0.05);
    expect(em.getRecent(1)[0].significance).toBeCloseTo(0.95, 6);
    em.strengthenEpisode(e.id, 0.5); // would exceed 1.0
    expect(em.getRecent(1)[0].significance).toBe(1);
  });

  it('EPS-12: weakenEpisode subtracts delta and floors at 0', () => {
    const e = ep({ significance: 0.1 });
    em.recordEpisode(e);
    em.weakenEpisode(e.id, 0.05);
    expect(em.getRecent(1)[0].significance).toBeCloseTo(0.05, 6);
    em.weakenEpisode(e.id, 0.5); // would go negative
    expect(em.getRecent(1)[0].significance).toBe(0);
  });

  it('EPS-13: strengthen→weaken round-trip restores the original weight', () => {
    const e = ep({ significance: 0.5 });
    em.recordEpisode(e);
    em.strengthenEpisode(e.id, 0.2);
    em.weakenEpisode(e.id, 0.2);
    expect(em.getRecent(1)[0].significance).toBeCloseTo(0.5, 6);
  });

  it('EPS-14: strengthen/weaken with unknown id is a warn-level no-op, not a throw', () => {
    const e = ep({ significance: 0.5 });
    em.recordEpisode(e);
    expect(() => em.strengthenEpisode('no-such-id', 0.1)).not.toThrow();
    expect(() => em.weakenEpisode('no-such-id', 0.1)).not.toThrow();
    expect(em.getRecent(1)[0].significance).toBeCloseTo(0.5, 6);
  });

  it('EPS-15: strengthen/weaken validate id and delta', () => {
    expect(() => em.strengthenEpisode('', 0.1)).toThrow(ConsciousnessError);
    expect(() => em.strengthenEpisode('x', 0)).toThrow(ConsciousnessError);
    expect(() => em.strengthenEpisode('x', -0.1)).toThrow(ConsciousnessError);
    expect(() => em.weakenEpisode('', 0.1)).toThrow(ConsciousnessError);
    expect(() => em.weakenEpisode('x', 0)).toThrow(ConsciousnessError);
  });
});
