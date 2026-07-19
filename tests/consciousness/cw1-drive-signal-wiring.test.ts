/**
 * @file tests/consciousness/cw1-drive-signal-wiring.test.ts
 * @description CW1 — un-sever real consciousness signals into drive computation.
 * Covers the two new read-only accessors (SelfModel.getImprovingRatio,
 * WorldModel.getAverageConfidence) and proves the drive-compute seam the
 * orchestrator wires (orchestrator.ts getConsciousnessContext) responds to a
 * real surprise signal — and that empty/unbooted modules fall back to the exact
 * placeholder constants CW1 replaced (recentSurprise:0, worldModelConfidence:0.5,
 * selfModelImprovingRatio:0.5), so behavior is unchanged when modules are cold.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsciousnessDB } from '../../src/core/consciousness/consciousness-db.js';
import { SelfModel } from '../../src/core/consciousness/self-model/index.js';
import { WorldModel } from '../../src/core/consciousness/world-model/index.js';
import { SurpriseEngine, saveSurpriseEvent } from '../../src/core/consciousness/surprise-engine/index.js';
import { DriveManager } from '../../src/core/consciousness/drive-system/index.js';
import type { EpisodeLike } from '../../src/core/consciousness/self-model/types.js';
import type { BodyState } from '../../src/core/consciousness/types.js';

let idc = 0;
function ep(overrides: Partial<EpisodeLike> = {}): EpisodeLike {
  idc += 1;
  return { id: `ep-${idc}`, topic: 'coding', outcome: 'positive', significance: 0.5, ...overrides };
}

const NEUTRAL_BODY: BodyState = {
  energy: 0.6, clarity: 0.6, fullness: 0.5, connectivity: 0.5, continuity: 0.5,
  sampledAt: new Date().toISOString(),
};

let sc = 0;
function seedSurprise(cdb: ConsciousnessDB, magnitude: number): void {
  sc += 1;
  saveSurpriseEvent(cdb.getDb(), {
    id: `sp-${sc}`, predictionId: `pred-${sc}`, magnitude,
    direction: 'different', description: 'test event', triggeredActions: [],
    createdAt: new Date().toISOString(),
  });
}

describe('CW1 — real signals into drive computation', () => {
  let tempDir: string;
  let cdb: ConsciousnessDB;

  beforeEach(() => {
    idc = 0; sc = 0;
    tempDir = mkdtempSync(join(tmpdir(), 'cw1-'));
    cdb = new ConsciousnessDB(join(tempDir, 'c.db'));
  });
  afterEach(() => {
    try { cdb.getDb().close(); } catch { /* ignore */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -- Accessor: SelfModel.getImprovingRatio ------------------------------
  it('CW1-A1: getImprovingRatio returns the 0.5 fallback when no assessments exist', () => {
    const sm = new SelfModel(cdb);
    expect(sm.getImprovingRatio()).toBe(0.5);
  });

  it('CW1-A2: getImprovingRatio reflects the fraction of improving-trend capabilities', () => {
    const sm = new SelfModel(cdb);
    // 12 positives on one topic -> that capability's trend becomes "improving".
    for (let i = 0; i < 12; i++) sm.updateFromEpisode(ep({ topic: 'coding', outcome: 'positive' }));
    expect(sm.getImprovingRatio()).toBe(1); // 1 of 1 domains improving
    // Add a domain that stays non-improving (few, mixed events -> stable/declining).
    sm.updateFromEpisode(ep({ topic: 'ops', outcome: 'negative' }));
    const ratio = sm.getImprovingRatio();
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1); // now 1 of 2 domains improving
  });

  // -- Accessor: WorldModel.getAverageConfidence --------------------------
  it('CW1-A3: getAverageConfidence returns the 0.5 fallback when no pending predictions exist', () => {
    const wm = new WorldModel(cdb);
    expect(wm.getAverageConfidence()).toBe(0.5);
  });

  it('CW1-A4: getAverageConfidence averages pending prediction confidence', () => {
    const wm = new WorldModel(cdb);
    wm.save(wm.predict('domA', 'x', 0.8));
    wm.save(wm.predict('domB', 'y', 0.4));
    expect(wm.getAverageConfidence()).toBeCloseTo(0.6, 6);
  });

  // -- Wiring seam: surprise flows into the drive vector ------------------
  it('CW1-W1: a high real surprise signal raises curiosity and lowers boredom vs zero surprise', () => {
    const se = new SurpriseEngine(cdb);
    const dm = new DriveManager(cdb);

    // Cold store: the accessor returns 0 -> identical to the old hardcoded constant.
    expect(se.getAverageSurprise(24)).toBe(0);
    const low = dm.compute({
      bodyState: NEUTRAL_BODY, emotionalTags: {}, emotionalIntensity: 0,
      recentSurprise: se.getAverageSurprise(24), recentInteractionRate: 0.5,
      worldModelConfidence: 0.5, selfModelImprovingRatio: 0.5, timeSinceLastInteractionMs: 0,
    });
    const lowCuriosity = low.find((d) => d.name === 'curiosity')!.intensity;
    const lowDominant = dm.getDominant().name;

    // Seed several high-magnitude surprise events -> average ~0.9.
    for (let i = 0; i < 5; i++) seedSurprise(cdb, 0.9);
    const avg = se.getAverageSurprise(24);
    expect(avg).toBeGreaterThan(0.6); // real, non-constant signal now flowing

    const high = dm.compute({
      bodyState: NEUTRAL_BODY, emotionalTags: {}, emotionalIntensity: 0,
      recentSurprise: avg, recentInteractionRate: 0.5,
      worldModelConfidence: 0.5, selfModelImprovingRatio: 0.5, timeSinceLastInteractionMs: 0,
    });
    const highCuriosity = high.find((d) => d.name === 'curiosity')!.intensity;
    const highBoredom = high.find((d) => d.name === 'boredom')!.intensity;
    const lowBoredom = low.find((d) => d.name === 'boredom')!.intensity;

    // The drive output MUST change once the real surprise signal is wired.
    expect(highCuriosity).toBeGreaterThan(lowCuriosity);
    expect(highBoredom).toBeLessThan(lowBoredom);
    // And that is enough to flip the dominant drive away from the low-surprise one.
    expect(dm.getDominant().name).not.toBe(lowDominant);
  });
});
