/**
 * @file tests/brain/consensus-early-exit.test.ts
 * @description C8 — latency-aware consensus preemption in queryAllModelsConsensus.
 *
 *  1. EXIT-1: default (no options) → waits for ALL models (behavior-preserving).
 *  2. EXIT-2: early-exits once a quorum agrees, without waiting for slower models.
 *  3. EXIT-3: a timeout resolves with whatever has completed.
 *  4. EXIT-4: SUDO_CONSENSUS_EARLY_EXIT_DISABLE=1 forces the wait-all path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { queryAllModelsConsensus, type BrainModelResult } from '../../src/core/brain/model-consensus.js';

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCost: 0 };
function result(model: string, content: string): BrainModelResult {
  return { model, content, toolCalls: [], latencyMs: 0, usage: USAGE };
}
// Identical, agreeing content (words > 4 chars drive Jaccard).
const AGREE = 'agreeing answer paragraph consensus reasoning';

describe('C8: latency-aware consensus preemption', () => {
  const ENV = 'SUDO_CONSENSUS_EARLY_EXIT_DISABLE';
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[ENV]; delete process.env[ENV]; });
  afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });

  it('EXIT-1: default options wait for all models', async () => {
    const called: string[] = [];
    const caller = (m: string) => { called.push(m); return Promise.resolve(result(m, AGREE)); };
    const { result: winner } = await queryAllModelsConsensus(['m1', 'm2', 'm3'], caller);
    expect(called.sort()).toEqual(['m1', 'm2', 'm3']);
    expect(['m1', 'm2', 'm3']).toContain(winner.model);
  });

  it('EXIT-2: early-exits on quorum agreement without waiting for the slow model', async () => {
    let thirdResolved = false;
    let releaseThird!: (r: BrainModelResult) => void;
    const thirdPromise = new Promise<BrainModelResult>((res) => { releaseThird = res; });

    const caller = (m: string): Promise<BrainModelResult> => {
      if (m === 'slow') return thirdPromise.then((r) => { thirdResolved = true; return r; });
      return Promise.resolve(result(m, AGREE)); // m1, m2 agree immediately
    };

    const { result: winner } = await queryAllModelsConsensus(
      ['m1', 'm2', 'slow'],
      caller,
      { minAgreement: 0.5, minResponders: 2 },
    );

    expect(thirdResolved).toBe(false);           // resolved without the slow model
    expect(['m1', 'm2']).toContain(winner.model);
    releaseThird(result('slow', AGREE));         // cleanup the dangling promise
  });

  it('EXIT-3: a timeout resolves with whatever completed', async () => {
    const caller = (m: string): Promise<BrainModelResult> => {
      if (m === 'fast') return Promise.resolve(result(m, AGREE));
      return new Promise<BrainModelResult>(() => { /* never resolves */ });
    };
    const { result: winner } = await queryAllModelsConsensus(
      ['fast', 'hang1', 'hang2'],
      caller,
      { timeoutMs: 60 },
    );
    expect(winner.model).toBe('fast');
  });

  it('EXIT-4: kill-switch forces the wait-all path even with minAgreement set', async () => {
    process.env[ENV] = '1';
    const called: string[] = [];
    const caller = (m: string) => { called.push(m); return Promise.resolve(result(m, AGREE)); };
    await queryAllModelsConsensus(['m1', 'm2', 'm3'], caller, { minAgreement: 0.1, minResponders: 1 });
    expect(called.sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('EXIT-5: minAgreement <= 0 is treated as unset (no degenerate early-exit)', async () => {
    const called: string[] = [];
    const caller = (m: string) => { called.push(m); return Promise.resolve(result(m, AGREE)); };
    // minAgreement=0 must NOT collapse to a 1-responder exit — it waits for all.
    await queryAllModelsConsensus(['m1', 'm2', 'm3'], caller, { minAgreement: 0, minResponders: 1 });
    expect(called.sort()).toEqual(['m1', 'm2', 'm3']);
  });
});
