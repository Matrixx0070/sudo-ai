/**
 * F83 — SleepCycle adapter binding.
 * reflectOn=false must preserve the legacy no-op stubs exactly;
 * reflectOn=true must delegate every adapter to the real engines.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildSleepCycleAdapters } from '../../src/core/consciousness/sleep-adapters.js';
import type { ConsciousnessOrchestrator } from '../../src/core/consciousness/orchestrator.js';

function fakeOrchestrator() {
  const episodic = {
    getBySignificance: vi.fn(() => [{ id: 'e1', summary: 's', significance: 0.9, outcome: 'positive', topic: 't', startedAt: 'now' }]),
    strengthenEpisode: vi.fn(),
    weakenEpisode: vi.fn(),
  };
  const counterfactual = { runIdleBatch: vi.fn(async () => [{ lessonLearned: 'L' }]) };
  const metacognition = { runBatchReflection: vi.fn(async () => ['r']) };
  const selfModel = { updateFromEpisode: vi.fn() };
  const temporalSelf = { takeSnapshot: vi.fn(() => ({ id: 'snap' })) };
  return {
    orchestrator: {
      getEpisodicMemory: () => episodic,
      getCounterfactualEngine: () => counterfactual,
      getMetacognitionEngine: () => metacognition,
      getSelfModel: () => selfModel,
      getTemporalSelf: () => temporalSelf,
    } as unknown as ConsciousnessOrchestrator,
    episodic, counterfactual, metacognition, selfModel, temporalSelf,
  };
}

describe('buildSleepCycleAdapters (F83)', () => {
  it('reflectOn=false → inert stubs, engines never touched', async () => {
    const f = fakeOrchestrator();
    const a = buildSleepCycleAdapters(false, f.orchestrator, null);
    expect(a.episodicMemory.getBySignificance(5)).toEqual([]);
    expect(await a.counterfactualEngine.runIdleBatch(3)).toEqual([]);
    expect(await a.metacognition.runBatchReflection(3)).toEqual([]);
    a.selfModel.updateFromEpisode({ id: 'x', topic: 't', outcome: 'positive', significance: 1 });
    a.temporalSelf.takeSnapshot({ dominantEmotion: 'calm' }, []);
    a.wisdomStore.storeInsight({ category: 'pattern', source: 'pipeline', insight: 'i', confidence: 0.5 });
    expect(f.episodic.getBySignificance).not.toHaveBeenCalled();
    expect(f.selfModel.updateFromEpisode).not.toHaveBeenCalled();
  });

  it('reflectOn=true → every adapter delegates to the real engines', async () => {
    const f = fakeOrchestrator();
    const wisdom = { storeInsight: vi.fn(() => 1) };
    const a = buildSleepCycleAdapters(true, f.orchestrator, wisdom);

    expect(a.episodicMemory.getBySignificance(1)).toHaveLength(1);
    expect(f.episodic.getBySignificance).toHaveBeenCalledWith(1);

    a.episodicMemory.strengthenEpisode('e1', 0.1);
    expect(f.episodic.strengthenEpisode).toHaveBeenCalledWith('e1', 0.1);

    await a.counterfactualEngine.runIdleBatch(2);
    expect(f.counterfactual.runIdleBatch).toHaveBeenCalledWith(f.episodic, 2);

    await a.metacognition.runBatchReflection(4);
    expect(f.metacognition.runBatchReflection).toHaveBeenCalledWith(f.episodic, 4);

    const ep = { id: 'e1', topic: 't', outcome: 'positive' as const, significance: 0.9 };
    a.selfModel.updateFromEpisode(ep);
    expect(f.selfModel.updateFromEpisode).toHaveBeenCalledWith(ep);

    a.temporalSelf.takeSnapshot({ dominantEmotion: 'joy' }, ['g1']);
    expect(f.temporalSelf.takeSnapshot).toHaveBeenCalledWith({ dominantEmotion: 'joy' }, ['g1']);

    a.wisdomStore.storeInsight({ category: 'success', source: 'pipeline', insight: 'w', confidence: 0.8 });
    expect(wisdom.storeInsight).toHaveBeenCalled();
  });

  it('reflectOn=true with no wisdom store → wisdom path stays no-op', () => {
    const f = fakeOrchestrator();
    const a = buildSleepCycleAdapters(true, f.orchestrator, null);
    expect(a.wisdomStore.storeInsight({ category: 'pattern', source: 'pipeline', insight: 'i', confidence: 0.5 })).toBeUndefined();
  });
});
