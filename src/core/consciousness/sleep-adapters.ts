/**
 * @file sleep-adapters.ts
 * @description F83 (docs/CORE_ROADMAP.md) — binds the SleepCycle's duck-typed
 * dependencies to the REAL consciousness engines when reflection is on.
 *
 * Before F83, cli.ts always injected no-op stubs for episodicMemory /
 * selfModel / temporalSelf / wisdomStore regardless of
 * SUDO_CONSCIOUSNESS_REFLECT — sleep consolidation ran against empty data and
 * the self-model / timeline / wisdom learning paths were inert even with
 * reflection enabled.
 *
 * reflectOn=false preserves the legacy zero-cost / zero-behavior-change
 * stubs exactly.
 */

import type { ConsciousnessOrchestrator } from './orchestrator.js';
import type {
  SleepEpisodicLike,
  SleepCounterfactualLike,
  SleepSelfModelLike,
  SleepTemporalSelfLike,
  SleepMetacognitionLike,
  SleepWisdomLike,
} from './sleep-cycle/types.js';
import type { EmotionTag } from './types.js';

export interface SleepCycleAdapters {
  episodicMemory: SleepEpisodicLike;
  counterfactualEngine: SleepCounterfactualLike;
  selfModel: SleepSelfModelLike;
  temporalSelf: SleepTemporalSelfLike;
  metacognition: SleepMetacognitionLike;
  wisdomStore: SleepWisdomLike;
}

const STUBS: SleepCycleAdapters = {
  episodicMemory: {
    getBySignificance: () => [],
    strengthenEpisode: () => undefined,
    weakenEpisode: () => undefined,
  },
  counterfactualEngine: { runIdleBatch: async () => [] },
  selfModel: { updateFromEpisode: () => undefined },
  temporalSelf: { takeSnapshot: () => undefined },
  metacognition: { runBatchReflection: async () => [] },
  wisdomStore: { storeInsight: () => undefined },
};

/**
 * Build the six SleepCycle dependency adapters.
 * @param reflectOn - SUDO_CONSCIOUSNESS_REFLECT=1; false → legacy stubs.
 * @param orchestrator - the booted ConsciousnessOrchestrator (real engines).
 * @param wisdom - optional real wisdom store (learning/store.ts WisdomStore);
 *                 null keeps the wisdom path a no-op.
 */
export function buildSleepCycleAdapters(
  reflectOn: boolean,
  orchestrator: ConsciousnessOrchestrator,
  wisdom: { storeInsight(insight: { category: string; source: string; insight: string; confidence: number }): unknown } | null,
): SleepCycleAdapters {
  if (!reflectOn) return STUBS;

  const episodic = orchestrator.getEpisodicMemory();
  return {
    // Real episodic store: consolidation now runs over live episodes and
    // strengthen/weaken actually persist.
    episodicMemory: episodic,
    counterfactualEngine: {
      runIdleBatch: (count: number) => orchestrator.getCounterfactualEngine().runIdleBatch(episodic, count),
    },
    metacognition: {
      runBatchReflection: (count: number) => orchestrator.getMetacognitionEngine().runBatchReflection(episodic, count),
    },
    selfModel: {
      updateFromEpisode: (episode) => orchestrator.getSelfModel().updateFromEpisode(episode),
    },
    temporalSelf: {
      takeSnapshot: (emotionalState, goals) =>
        orchestrator.getTemporalSelf().takeSnapshot(
          { dominantEmotion: emotionalState.dominantEmotion as EmotionTag },
          goals,
        ),
    },
    wisdomStore: wisdom ?? STUBS.wisdomStore,
  };
}
