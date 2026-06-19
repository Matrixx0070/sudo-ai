/**
 * @file tests/consciousness/episodic-dedup.test.ts
 * @description Opt-in episodic dedup (SUDO_EPISODIC_DEDUP=1): byte-identical
 * summaries recorded within the dedup window are collapsed into a single
 * episode (the survivor is strengthened) instead of accumulating duplicate
 * rows. Reproduces the heartbeat-replay bloat (one heartbeat observed ×178).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsciousnessDB } from '../../src/core/consciousness/consciousness-db.js';
import { EpisodicMemory } from '../../src/core/consciousness/episodic-memory/index.js';
import type { Episode } from '../../src/core/consciousness/episodic-memory/types.js';

let idc = 0;
function ep(summary: string): Episode {
  idc += 1;
  const now = new Date().toISOString();
  return {
    id: `e${idc}`,
    summary,
    participants: ['user-1'],
    topic: 'heartbeat',
    tags: [],
    emotionalValence: { tags: ['calm'], dominantEmotion: 'calm', intensity: 0.3 },
    surpriseLevel: 0,
    outcome: 'neutral',
    significance: 0.5,
    sessionId: 's1',
    startedAt: now,
    endedAt: now,
    durationMs: 0,
  };
}

describe('Episodic dedup (opt-in)', () => {
  let tempDir: string;
  let cdb: ConsciousnessDB;
  let em: EpisodicMemory;

  beforeEach(() => {
    idc = 0;
    tempDir = mkdtempSync(join(tmpdir(), 'dedup-test-'));
    cdb = new ConsciousnessDB(join(tempDir, 'c.db'));
    em = new EpisodicMemory(cdb);
  });
  afterEach(() => {
    delete process.env.SUDO_EPISODIC_DEDUP;
    try { cdb.getDb().close(); } catch { /* ignore */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('DEDUP-1: identical summaries collapse to one row when enabled', () => {
    process.env.SUDO_EPISODIC_DEDUP = '1';
    const HB = '[HEARTBEAT @ 2026-06-10T19:42:59.099Z] no change';
    for (let i = 0; i < 10; i++) em.recordEpisode(ep(HB));

    const stored = em.getRecent(50);
    expect(stored.length).toBe(1);
    // Survivor was strengthened on each suppressed recurrence (0.5 + 9*0.02).
    expect(stored[0]!.significance).toBeGreaterThan(0.5);
  });

  it('DEDUP-2: distinct summaries are all preserved', () => {
    process.env.SUDO_EPISODIC_DEDUP = '1';
    em.recordEpisode(ep('alpha'));
    em.recordEpisode(ep('beta'));
    em.recordEpisode(ep('gamma'));
    expect(em.getRecent(50).length).toBe(3);
  });

  it('DEDUP-3: disabled by default → duplicates still accumulate (back-compat)', () => {
    const HB = 'same summary every time';
    for (let i = 0; i < 5; i++) em.recordEpisode(ep(HB));
    expect(em.getRecent(50).length).toBe(5);
  });
});
