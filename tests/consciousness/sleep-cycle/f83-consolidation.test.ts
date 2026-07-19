/**
 * @file f83-consolidation.test.ts
 * @description F83 — proves a sleep consolidation cycle actually consolidates
 * over a REAL episode store. Seeds a temp consciousness.db with episodes, runs
 * one startSleep() pass with the LLM (brain) mocked, and asserts a persisted
 * sleep_sessions row with episodes_replayed > 0 and non-empty results.
 *
 * Also verifies invariant-9 safety: the sleep-adapters weaken path is flag-only
 * by default (no significance mutation) and only performs force-decay surgery
 * when SUDO_SLEEP_MEMORY_SURGERY=1.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsciousnessDB } from '../../../src/core/consciousness/consciousness-db.js';
import { EpisodicMemory } from '../../../src/core/consciousness/episodic-memory/index.js';
import { SleepCycle } from '../../../src/core/consciousness/sleep-cycle/consolidator.js';
import { getRecentSessions } from '../../../src/core/consciousness/sleep-cycle/store.js';
import type { Episode } from '../../../src/core/consciousness/episodic-memory/types.js';

function makeEpisode(over: Partial<Episode>): Episode {
  const now = new Date().toISOString();
  return {
    id: over.id ?? `ep-${Math.random().toString(36).slice(2)}`,
    summary: over.summary ?? 'Resolved a tool-selection ambiguity during a browser task.',
    participants: ['user', 'agent'],
    topic: over.topic ?? 'tooling',
    tags: ['browser', 'tool'],
    emotionalValence: 'positive',
    surpriseLevel: 0.2,
    outcome: over.outcome ?? 'positive',
    significance: over.significance ?? 0.9,
    sessionId: 's1',
    startedAt: over.startedAt ?? now,
    endedAt: over.endedAt ?? now,
    durationMs: 1000,
  } as Episode;
}

describe('F83 sleep consolidation over a real episode store', () => {
  let dir: string;
  let cdb: ConsciousnessDB;
  let episodic: EpisodicMemory;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'f83-'));
    cdb = new ConsciousnessDB(join(dir, 'consciousness.db'));
    episodic = new EpisodicMemory(cdb);
    // Seed 25 episodes so Phase 1 (top-20) replays a non-empty set.
    for (let i = 0; i < 25; i++) {
      episodic.recordEpisode(makeEpisode({ id: `high-${i}`, significance: 0.9 }));
    }
  });

  afterEach(() => {
    try { cdb.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
    delete process.env['SUDO_SLEEP_MEMORY_SURGERY'];
  });

  it('replays real episodes, generates insights, and persists a sleep_sessions row', async () => {
    const wisdomCalls: unknown[] = [];
    const brainCall = vi.fn(async () => ({
      content: '1. Prefer the durable browser profile for repeat logins.\n2. Escalate ambiguous tool choices to the planner.',
    }));

    const cycle = new SleepCycle({
      cdb,
      brain: { call: brainCall },
      episodicMemory: episodic,
      counterfactualEngine: { runIdleBatch: async () => [] },
      selfModel: { updateFromEpisode: () => undefined },
      temporalSelf: { takeSnapshot: () => undefined },
      metacognition: { runBatchReflection: async () => [] },
      wisdomStore: { storeInsight: (i) => { wisdomCalls.push(i); return undefined; } },
    });

    const session = await cycle.startSleep();

    // Returned session consolidated real data.
    expect(session.episodesReplayed).toBe(20);
    expect(session.memoriesStrengthened).toBe(20); // all significance 0.9 > 0.7
    expect(session.patternsFound).toBeGreaterThan(0);
    expect(session.insightsGenerated).toBeGreaterThan(0);
    expect(session.degraded).toBe(false);
    expect(wisdomCalls.length).toBeGreaterThan(0);
    expect(brainCall).toHaveBeenCalled();

    // Persisted row in sleep_sessions reflects the same non-empty consolidation.
    const rows = getRecentSessions(cdb.getDb(), 5);
    expect(rows.length).toBe(1);
    expect(rows[0]!.episodesReplayed).toBe(20);
    expect(rows[0]!.insightsGenerated).toBeGreaterThan(0);
  });
});

describe('F83 invariant-9: sleep weaken path is flag-only by default', () => {
  let dir: string;
  let cdb: ConsciousnessDB;
  let episodic: EpisodicMemory;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'f83w-'));
    cdb = new ConsciousnessDB(join(dir, 'consciousness.db'));
    episodic = new EpisodicMemory(cdb);
  });

  afterEach(() => {
    try { cdb.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
    delete process.env['SUDO_SLEEP_MEMORY_SURGERY'];
  });

  async function buildAdapters(reflectOn: boolean) {
    const { buildSleepCycleAdapters } = await import('../../../src/core/consciousness/sleep-adapters.js');
    const orch = {
      getEpisodicMemory: () => episodic,
      getCounterfactualEngine: () => ({ runIdleBatch: async () => [] }),
      getMetacognitionEngine: () => ({ runBatchReflection: async () => [] }),
      getSelfModel: () => ({ updateFromEpisode: () => undefined }),
      getTemporalSelf: () => ({ takeSnapshot: () => undefined }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return buildSleepCycleAdapters(reflectOn, orch as any, null);
  }

  it('flag-only: weakenEpisode does NOT mutate significance without consensus', async () => {
    const oldIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    episodic.recordEpisode(makeEpisode({ id: 'decay-1', significance: 0.2, startedAt: oldIso, endedAt: oldIso }));

    const a = await buildAdapters(true);
    a.episodicMemory.weakenEpisode('decay-1', 0.05);

    const after = cdb.getDb().prepare('SELECT significance FROM episodes WHERE id = ?').get('decay-1') as { significance: number };
    expect(after.significance).toBe(0.2); // unchanged — flag-only
  });

  it('surgery gated: SUDO_SLEEP_MEMORY_SURGERY=1 performs the real force-decay', async () => {
    const oldIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    episodic.recordEpisode(makeEpisode({ id: 'decay-2', significance: 0.2, startedAt: oldIso, endedAt: oldIso }));
    process.env['SUDO_SLEEP_MEMORY_SURGERY'] = '1';

    const a = await buildAdapters(true);
    a.episodicMemory.weakenEpisode('decay-2', 0.05);

    const after = cdb.getDb().prepare('SELECT significance FROM episodes WHERE id = ?').get('decay-2') as { significance: number };
    expect(after.significance).toBeCloseTo(0.15, 5);
  });
});
