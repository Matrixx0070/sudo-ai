/**
 * @file tests/consciousness/metacognition-reflect.test.ts
 * @description Theme 4 (reflect loops) — the dormant Metacognition engine, when
 * driven (as the sleep cycle now does when SUDO_CONSCIOUSNESS_REFLECT=1),
 * GENERATES + persists reflections from recent episodes. Validates the activated
 * loop with a mock brain (the engine is LLM-backed, so it lives off the hot path).
 *
 * This is the representative reflect loop; Counterfactual is wired symmetrically
 * (same adapter shape in cli.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsciousnessDB } from '../../src/core/consciousness/consciousness-db.js';
import { EpisodicMemory } from '../../src/core/consciousness/episodic-memory/index.js';
import { MetacognitionEngine } from '../../src/core/consciousness/metacognition/index.js';
import type { MetaBrainLike } from '../../src/core/consciousness/metacognition/index.js';
import type { Episode } from '../../src/core/consciousness/episodic-memory/types.js';

// Mock brain: returns the ANALYSIS/CONCLUSION/ACTION structure reflect() parses.
const mockBrain: MetaBrainLike = {
  call: async () => ({ content: 'ANALYSIS: The agent reasoned soundly and used the right tools.\nCONCLUSION: Good outcome.\nACTION: Continue this approach.' }),
};

let idc = 0;
function ep(topic: string): Episode {
  idc += 1;
  const now = new Date().toISOString();
  return {
    id: `e${idc}`,
    summary: `handled a ${topic} request`,
    participants: ['user-1'],
    topic,
    tags: [],
    emotionalValence: { tags: ['calm'], dominantEmotion: 'calm', intensity: 0.3 },
    surpriseLevel: 0,
    outcome: 'positive',
    significance: 0.8, // high → surfaced by getBySignificance
    sessionId: 's1',
    startedAt: now,
    endedAt: now,
    durationMs: 0,
  };
}

describe('Theme 4: metacognition reflect loop (sleep-driven generation)', () => {
  let tempDir: string;
  let cdb: ConsciousnessDB;
  let em: EpisodicMemory;
  let engine: MetacognitionEngine;

  beforeEach(() => {
    idc = 0;
    tempDir = mkdtempSync(join(tmpdir(), 'meta-test-'));
    cdb = new ConsciousnessDB(join(tempDir, 'c.db'));
    em = new EpisodicMemory(cdb);
    engine = new MetacognitionEngine(cdb, mockBrain);
  });
  afterEach(() => {
    try { cdb.getDb().close(); } catch { /* ignore */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('META-1: runBatchReflection generates + persists reflections from episodes', async () => {
    em.recordEpisode(ep('billing'));
    em.recordEpisode(ep('weather'));
    em.recordEpisode(ep('travel'));

    const reflections = await engine.runBatchReflection(em, 3);
    expect(reflections.length).toBeGreaterThanOrEqual(1);
    // Persisted and readable as guidance.
    expect(engine.getReflections(10).length).toBeGreaterThanOrEqual(1);
  });

  it('META-2: a second pass does not duplicate reflections (dedup per episode)', async () => {
    em.recordEpisode(ep('billing'));
    await engine.runBatchReflection(em, 3);
    const second = await engine.runBatchReflection(em, 3);
    expect(second.length).toBe(0); // already reflected on the only episode
  });

  it('META-3: no episodes → nothing generated (no-op)', async () => {
    const reflections = await engine.runBatchReflection(em, 3);
    expect(reflections.length).toBe(0);
  });
});
