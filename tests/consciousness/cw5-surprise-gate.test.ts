/**
 * @file tests/consciousness/cw5-surprise-gate.test.ts
 * @description CW5 — surprise gates encoding + attention (SUDO_CAS_SURPRISE_GATE,
 * default OFF). Acceptance: a synthetic high-surprise event yields measurably
 * higher encode priority than a matched low-surprise event; flag OFF returns
 * the exact legacy constants; the <=2x cap is inherent (clamped [0,1] vs 0.5
 * baseline); retrieval rank reflects significance; the CW4 attention boost
 * raises episodic/metacognition bid values only while surprise >= 0.7.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsciousnessDB } from '../../src/core/consciousness/consciousness-db.js';
import {
  EpisodicMemory,
  computeEpisodeSignals,
} from '../../src/core/consciousness/episodic-memory/index.js';
import type { Episode } from '../../src/core/consciousness/episodic-memory/index.js';
import { collectBids } from '../../src/core/consciousness/context-arbiter/index.js';

let savedFlag: string | undefined;
beforeEach(() => { savedFlag = process.env['SUDO_CAS_SURPRISE_GATE']; });
afterEach(() => {
  if (savedFlag === undefined) delete process.env['SUDO_CAS_SURPRISE_GATE'];
  else process.env['SUDO_CAS_SURPRISE_GATE'] = savedFlag;
});

const baseParams = { messageCount: 4, toolCallCount: 2, hasError: false };

describe('CW5 — computeEpisodeSignals (encode gate)', () => {
  it('CW5-1: flag OFF returns the exact legacy constants regardless of inputs', () => {
    delete process.env['SUDO_CAS_SURPRISE_GATE'];
    expect(computeEpisodeSignals({ ...baseParams, surprise: 0.95, emotionalIntensity: 0.9 }))
      .toEqual({ surpriseLevel: 0, significance: 0.5 });
  });

  it('CW5-2: flag ON — synthetic high-surprise event encodes with higher priority than matched low-surprise', () => {
    process.env['SUDO_CAS_SURPRISE_GATE'] = '1';
    const high = computeEpisodeSignals({ ...baseParams, surprise: 0.9, emotionalIntensity: 0.8 });
    const low = computeEpisodeSignals({ ...baseParams, surprise: 0.05, emotionalIntensity: 0.1 });
    expect(high.significance).toBeGreaterThan(low.significance);
    expect(high.surpriseLevel).toBeCloseTo(0.9, 6);
    // Weights are real: surprise contributes 0.20, emotion 0.15 (recorder.ts).
    expect(high.significance - low.significance).toBeGreaterThan(0.2);
  });

  it('CW5-3: flood-guard cap — max significance is 1.0 = 2.0x the legacy 0.5 baseline, never more', () => {
    process.env['SUDO_CAS_SURPRISE_GATE'] = '1';
    const max = computeEpisodeSignals({
      surprise: 1, emotionalIntensity: 1, messageCount: 999, toolCallCount: 999, hasError: true,
    });
    expect(max.significance).toBeLessThanOrEqual(1.0);
    expect(max.significance / 0.5).toBeLessThanOrEqual(2.0);
  });

  it('CW5-4: out-of-range surprise clamps into [0,1]', () => {
    process.env['SUDO_CAS_SURPRISE_GATE'] = '1';
    expect(computeEpisodeSignals({ ...baseParams, surprise: 7, emotionalIntensity: 0 }).surpriseLevel).toBe(1);
    expect(computeEpisodeSignals({ ...baseParams, surprise: -3, emotionalIntensity: 0 }).surpriseLevel).toBe(0);
  });
});

describe('CW5 — retrieval rank reflects encode priority', () => {
  let dir: string;
  let cdb: ConsciousnessDB;
  let em: EpisodicMemory;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw5-'));
    cdb = new ConsciousnessDB(join(dir, 'c.db'));
    em = new EpisodicMemory(cdb);
  });
  afterEach(() => {
    try { cdb.getDb().close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  const ep = (id: string, significance: number, surpriseLevel: number): Episode => ({
    id, summary: `deploy pipeline broke ${id}`, participants: ['u'], topic: 'deploy pipeline',
    tags: [], emotionalValence: { dominantEmotion: 'frustration', intensity: 0.5, tags: [] },
    surpriseLevel, outcome: 'negative', significance,
    sessionId: 's', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 10,
  });

  it('CW5-5: higher-significance episode outranks a matched lower one on equal text hits', () => {
    em.recordEpisode(ep('low-sig', 0.35, 0.05));
    em.recordEpisode(ep('high-sig', 0.95, 0.9));
    const hits = em.recall('deploy pipeline broke', 2);
    expect(hits.length).toBe(2);
    expect(hits[0]!.id).toBe('high-sig'); // equal text hits -> significance breaks the tie
  });
});

describe('CW5 — attention re-weighting via CW4 bids', () => {
  const ctx = (surpriseLevel: number) => ({
    dominantDrive: { name: 'curiosity', intensity: 0.6 },
    emotionalState: { emotion: 'engaged', intensity: 0.5 },
    matchingProcedure: null,
    recentEpisodes: [{ summary: 'ep', outcome: 'positive', significance: 0.6, timestamp: 't' }],
    metacognitiveReflections: [{ conclusion: 'c', actionItem: 'a' }],
    surpriseLevel,
    selfCompetence: { overallConfidence: 0.8 },
  });

  it('CW5-6: flag ON + surprise >= 0.7 boosts episodic/metacognition bid values; others untouched', () => {
    process.env['SUDO_CAS_SURPRISE_GATE'] = '1';
    const boosted = collectBids(ctx(0.9));
    delete process.env['SUDO_CAS_SURPRISE_GATE'];
    const plain = collectBids(ctx(0.9));

    const val = (bids: ReturnType<typeof collectBids>, src: string) => bids.find((b) => b.source === src)!.value;
    expect(val(boosted, 'episodic')).toBeCloseTo(Math.min(1, val(plain, 'episodic') * 1.25), 6);
    expect(val(boosted, 'metacognition')).toBeCloseTo(Math.min(1, val(plain, 'metacognition') * 1.25), 6);
    expect(val(boosted, 'drive')).toBeCloseTo(val(plain, 'drive'), 6); // non-target unchanged
  });

  it('CW5-7: below the 0.7 threshold no boost applies (self-expiring as the average decays)', () => {
    process.env['SUDO_CAS_SURPRISE_GATE'] = '1';
    const under = collectBids(ctx(0.5));
    delete process.env['SUDO_CAS_SURPRISE_GATE'];
    const plain = collectBids(ctx(0.5));
    expect(under.find((b) => b.source === 'episodic')!.value)
      .toBeCloseTo(plain.find((b) => b.source === 'episodic')!.value, 6);
  });
});
