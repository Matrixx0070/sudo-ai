/**
 * @file tests/consciousness/episodic-semantic.test.ts
 * @description Theme 4.3 — episodic -> semantic consolidation: a dominant recurring
 * episode topic is folded into a single high-significance 'semantic' meta-episode.
 * This is the behavior the orchestrator now invokes at onInteractionEnd, gated by
 * SUDO_CONSCIOUSNESS_SEMANTIC=1.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsciousnessDB } from '../../src/core/consciousness/consciousness-db.js';
import { EpisodicMemory } from '../../src/core/consciousness/episodic-memory/index.js';
import type { Episode } from '../../src/core/consciousness/episodic-memory/types.js';

let idc = 0;
function ep(topic: string, outcome: Episode['outcome'] = 'positive'): Episode {
  idc += 1;
  const now = new Date().toISOString();
  return {
    id: `e${idc}`,
    summary: `episode about ${topic}`,
    participants: ['user-1'],
    topic,
    tags: [],
    emotionalValence: { tags: ['calm'], dominantEmotion: 'calm', intensity: 0.3 },
    surpriseLevel: 0,
    outcome,
    significance: 0.5,
    sessionId: 's1',
    startedAt: now,
    endedAt: now,
    durationMs: 0,
  };
}

describe('Theme 4.3: episodic -> semantic consolidation', () => {
  let tempDir: string;
  let cdb: ConsciousnessDB;
  let em: EpisodicMemory;

  beforeEach(() => {
    idc = 0;
    tempDir = mkdtempSync(join(tmpdir(), 'sem-test-'));
    cdb = new ConsciousnessDB(join(tempDir, 'c.db'));
    em = new EpisodicMemory(cdb);
  });
  afterEach(() => {
    try { cdb.getDb().close(); } catch { /* ignore */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('SEM-1: a dominant recurring topic is folded into a semantic episode', () => {
    em.recordEpisode(ep('billing'));
    em.recordEpisode(ep('billing'));
    em.recordEpisode(ep('billing'));
    em.recordEpisode(ep('weather'));

    const semantic = em.consolidateToSemantic({ minSupport: 3 });
    expect(semantic).not.toBeNull();
    expect(semantic!.topic).toBe('billing');
    expect(semantic!.tags).toContain('semantic');
    expect(semantic!.significance).toBeGreaterThan(0.8);

    // Persisted: a semantic episode for 'billing' is now in the store.
    const stored = em.getRecent(20).filter((e) => e.tags.includes('semantic') && e.topic === 'billing');
    expect(stored.length).toBe(1);
  });

  it('SEM-2: a second pass does not re-consolidate the same topic (dedup)', () => {
    for (let i = 0; i < 3; i++) em.recordEpisode(ep('billing'));
    expect(em.consolidateToSemantic({ minSupport: 3 })).not.toBeNull();
    // Already generalized → null the second time.
    expect(em.consolidateToSemantic({ minSupport: 3 })).toBeNull();
  });

  it('SEM-3: no topic reaches the threshold → nothing is consolidated', () => {
    em.recordEpisode(ep('billing'));
    em.recordEpisode(ep('billing')); // only 2
    em.recordEpisode(ep('weather'));
    em.recordEpisode(ep('weather')); // only 2
    expect(em.consolidateToSemantic({ minSupport: 3 })).toBeNull();
  });
});
