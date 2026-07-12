/**
 * Episodic recall primitive (gap #5) — proves EpisodicMemory.search() returns
 * relevant past episodes with their outcome, so the orchestrator can inject them
 * into the turn-start prompt instead of leaving episodic memory write-only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsciousnessDB } from '../../src/core/consciousness/consciousness-db.js';
import { EpisodicMemory } from '../../src/core/consciousness/episodic-memory/index.js';
import type { Episode } from '../../src/core/consciousness/episodic-memory/types.js';

let idc = 0;
function ep(summary: string, outcome: Episode['outcome'] = 'neutral'): Episode {
  idc += 1;
  const now = new Date().toISOString();
  return {
    id: `e${idc}`, summary, participants: ['user-1'], topic: 'general', tags: [],
    emotionalValence: { tags: ['calm'], dominantEmotion: 'calm', intensity: 0.3 },
    surpriseLevel: 0, outcome, significance: 0.6, sessionId: 's1',
    startedAt: now, endedAt: now, durationMs: 0,
  };
}

describe('EpisodicMemory.search — decision-time recall', () => {
  let cdb: ConsciousnessDB;
  let tempDir: string;
  let em: EpisodicMemory;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'recall-test-'));
    cdb = new ConsciousnessDB(join(tempDir, 'c.db'));
    em = new EpisodicMemory(cdb);
  });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('recalls episodes from a free-form message, ranked, carrying their outcome', () => {
    em.recordEpisode(ep('Deployed the payment service and it crashed on startup', 'negative'));
    em.recordEpisode(ep('Wrote a haiku about the ocean', 'positive'));
    // Free-form message — words overlap the summary but are NOT a verbatim substring.
    const hits = em.recall('can you help me deploy the payment service again?', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.summary.toLowerCase()).toContain('payment');
    expect(hits[0]!.outcome).toBe('negative');
  });

  it('ranks the episode hitting more query words first', () => {
    em.recordEpisode(ep('Configured DNS records for the payment domain', 'positive'));
    em.recordEpisode(ep('Deployed the payment service to production successfully', 'positive'));
    const hits = em.recall('deploy the payment service to production', 5);
    expect(hits[0]!.summary.toLowerCase()).toContain('deployed the payment service');
  });

  it('returns nothing for an unrelated message', () => {
    em.recordEpisode(ep('Configured the DNS records for the new domain', 'positive'));
    const hits = em.recall('quantum chromodynamics lecture notes', 3);
    expect(hits.length).toBe(0);
  });

  it('literal search() still works for exact substrings', () => {
    em.recordEpisode(ep('Rotated the GitHub PAT token', 'positive'));
    expect(em.search('GitHub PAT', 3).length).toBeGreaterThan(0);
  });
});
