/**
 * brain-verifier-compose — composition primitive unit tests.
 *
 * Pure-function suite: sub-verifiers are inline stubs returning the
 * value the test demands. No sandbox, no brain, no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  makeCompositeVerifier,
  type Verifier,
} from '../../../src/core/brain/brain-verifier-compose.js';
import type { BrainResponse, BrainRequest } from '../../../src/core/brain/types.js';
import type { VerifierResult } from '../../../src/core/brain/brain-tree-search.js';

function mkResp(content = 'demo'): BrainResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
    model: 'ollama/kimi-k2.7-code:cloud',
    finishReason: 'stop',
  };
}
const REQ: BrainRequest = { messages: [{ role: 'user', content: 'demo' }] };
const stub = (r: VerifierResult): Verifier => async () => r;

describe('makeCompositeVerifier — construction', () => {
  it('throws on empty verifier list', () => {
    expect(() => makeCompositeVerifier([])).toThrow(/at least one verifier/);
  });

  it('throws on weighted mode without weights', () => {
    expect(() =>
      makeCompositeVerifier([stub({ score: 1 })], { mode: 'weighted' }),
    ).toThrow(/weighted mode requires weights/);
  });

  it('throws on weighted weight-length mismatch', () => {
    expect(() =>
      makeCompositeVerifier([stub({ score: 1 }), stub({ score: 1 })], {
        mode: 'weighted',
        weights: [1],
      }),
    ).toThrow(/same length as verifiers/);
  });

  it('throws on weighted mode with zero/negative weight sum', () => {
    expect(() =>
      makeCompositeVerifier([stub({ score: 1 }), stub({ score: 1 })], {
        mode: 'weighted',
        weights: [0, 0],
      }),
    ).toThrow(/positive weight sum/);
  });

  it('throws on negative individual weight before sum check could mask it', () => {
    // [-1, 2] sums to 1 (positive) but the negative entry would normalise
    // to a negative coefficient and produce out-of-range scores. Catch
    // it at construction, not silently via the defensive clamp.
    expect(() =>
      makeCompositeVerifier([stub({ score: 1 }), stub({ score: 1 })], {
        mode: 'weighted',
        weights: [-1, 2],
      }),
    ).toThrow(/non-negative finite weights/);
  });

  it('throws on NaN weight', () => {
    expect(() =>
      makeCompositeVerifier([stub({ score: 1 }), stub({ score: 1 })], {
        mode: 'weighted',
        weights: [Number.NaN, 1],
      }),
    ).toThrow(/non-negative finite weights/);
  });
});

describe('makeCompositeVerifier — all mode (default)', () => {
  it('returns min score across sub-verifiers', async () => {
    const v = makeCompositeVerifier([stub({ score: 1 }), stub({ score: 0.4, reason: 'low' })]);
    const out = await v(mkResp(), REQ);
    expect(out.score).toBe(0.4);
    expect(out.reason).toMatch(/\[v1\] low/);
  });

  it('returns no reason when every judge accepts', async () => {
    const v = makeCompositeVerifier([stub({ score: 1 }), stub({ score: 1 })]);
    const out = await v(mkResp(), REQ);
    expect(out.score).toBe(1);
    expect(out.reason).toBeUndefined();
  });

  it('joins reasons from every sub-threshold judge with index tags', async () => {
    const v = makeCompositeVerifier([
      stub({ score: 0.2, reason: 'first bad' }),
      stub({ score: 1 }),
      stub({ score: 0.0, reason: 'third worse' }),
    ]);
    const out = await v(mkResp(), REQ);
    expect(out.score).toBe(0);
    expect(out.reason).toMatch(/\[v0\] first bad/);
    expect(out.reason).toMatch(/\[v2\] third worse/);
    expect(out.reason).not.toMatch(/\[v1\]/);
  });
});

describe('makeCompositeVerifier — any mode', () => {
  it('returns max score across sub-verifiers', async () => {
    const v = makeCompositeVerifier(
      [stub({ score: 0.1, reason: 'bad' }), stub({ score: 0.9 })],
      { mode: 'any' },
    );
    const out = await v(mkResp(), REQ);
    expect(out.score).toBe(0.9);
  });

  it('suppresses reasons when any judge accepts (keeps Reflexion log quiet)', async () => {
    const v = makeCompositeVerifier(
      [stub({ score: 0.1, reason: 'bad' }), stub({ score: 0.9 })],
      { mode: 'any' },
    );
    const out = await v(mkResp(), REQ);
    expect(out.reason).toBeUndefined();
  });

  it('surfaces every reason when every judge rejected', async () => {
    const v = makeCompositeVerifier(
      [stub({ score: 0.1, reason: 'a' }), stub({ score: 0.2, reason: 'b' })],
      { mode: 'any' },
    );
    const out = await v(mkResp(), REQ);
    expect(out.score).toBe(0.2);
    expect(out.reason).toMatch(/\[v0\] a/);
    expect(out.reason).toMatch(/\[v1\] b/);
  });
});

describe('makeCompositeVerifier — weighted mode', () => {
  it('returns weighted average with normalised weights', async () => {
    // raw weights 3:1 → normalised 0.75:0.25
    const v = makeCompositeVerifier(
      [stub({ score: 1 }), stub({ score: 0 })],
      { mode: 'weighted', weights: [3, 1] },
    );
    const out = await v(mkResp(), REQ);
    expect(out.score).toBeCloseTo(0.75, 5);
  });

  it('clamps score to [0,1] against floating drift', async () => {
    const v = makeCompositeVerifier(
      [stub({ score: 1 }), stub({ score: 1 })],
      { mode: 'weighted', weights: [1, 1] },
    );
    const out = await v(mkResp(), REQ);
    expect(out.score).toBe(1);
    expect(out.score).toBeLessThanOrEqual(1);
  });

  it('surfaces sub-threshold reasons even when weighted average passes', async () => {
    // weights 1:1 → score 0.7 (above default 0.5 threshold)
    // but v1 sat at 0.4 with a reason, which should still be logged
    const v = makeCompositeVerifier(
      [stub({ score: 1 }), stub({ score: 0.4, reason: 'second weak' })],
      { mode: 'weighted', weights: [1, 1] },
    );
    const out = await v(mkResp(), REQ);
    expect(out.score).toBeCloseTo(0.7, 5);
    expect(out.reason).toMatch(/\[v1\] second weak/);
  });
});

describe('makeCompositeVerifier — failure modes', () => {
  it('treats a throwing sub-verifier as score 0 with the error in reason', async () => {
    const thrower: Verifier = async () => { throw new Error('boom'); };
    const v = makeCompositeVerifier([stub({ score: 1 }), thrower]);
    const out = await v(mkResp(), REQ);
    expect(out.score).toBe(0);
    expect(out.reason).toMatch(/verifier 1 threw: boom/);
  });

  it('does not leak a sub-verifier throw past its own boundary', async () => {
    const thrower: Verifier = async () => { throw new Error('boom'); };
    const v = makeCompositeVerifier([thrower, thrower], { mode: 'any' });
    // Should NOT throw — composite swallows + scores 0.
    await expect(v(mkResp(), REQ)).resolves.toEqual({
      score: 0,
      reason: expect.stringMatching(/verifier 0 threw.*verifier 1 threw/),
    });
  });

  it('any mode with one throw + one accept returns the accept score and suppresses the throw reason', async () => {
    // Real-world production case: execVerifier crashes (e.g. sandbox
    // missing) but schemaVerifier accepts. The accept should win and
    // the noisy throw-message must NOT leak into the Reflexion log.
    const thrower: Verifier = async () => { throw new Error('sandbox missing'); };
    const v = makeCompositeVerifier([thrower, stub({ score: 0.9 })], { mode: 'any' });
    const out = await v(mkResp(), REQ);
    expect(out.score).toBe(0.9);
    expect(out.reason).toBeUndefined();
  });

  it('honours custom threshold', async () => {
    const v = makeCompositeVerifier(
      [stub({ score: 0.6, reason: 'mid' }), stub({ score: 1 })],
      { threshold: 0.7 },
    );
    const out = await v(mkResp(), REQ);
    // 'mid' sits BELOW threshold 0.7 so the reason should now surface,
    // where with the default 0.5 it would not.
    expect(out.reason).toMatch(/\[v0\] mid/);
  });

  it('accepts a sync verifier (covers TreeSearchOpts.verifier sync-or-async type)', async () => {
    const syncV: Verifier = () => ({ score: 0.8 });
    const v = makeCompositeVerifier([syncV]);
    const out = await v(mkResp(), REQ);
    expect(out.score).toBe(0.8);
  });
});
