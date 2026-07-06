/**
 * brain.call verifier-opt piping unit tests.
 *
 * Covers the BrainCallOpts extension (PR — this commit):
 *   - `verifier` and `breadth` reach `runTreeSearch` when strategy
 *     resolves to 'tree-search'.
 *   - Verifier forwards to debate (winner scoring) and tree-search; both are
 *     ignored on 'single' (no escape paths).
 *
 * The brain.ts call() body does a lot of setup we don't need here, so
 * the test drives `runTreeSearch` mock through a vi.mock indirect.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { runTreeSearchMock, runDebateMock } = vi.hoisted(() => ({
  runTreeSearchMock: vi.fn(),
  runDebateMock: vi.fn(),
}));

vi.mock('../../../src/core/brain/brain-tree-search.js', () => ({
  runTreeSearch: runTreeSearchMock,
}));
vi.mock('../../../src/core/brain/brain-debate.js', () => ({
  runDebate: runDebateMock,
}));

import { Brain } from '../../../src/core/brain/brain.js';
import type { BrainResponse } from '../../../src/core/brain/types.js';

const STUB_RESPONSE: BrainResponse = {
  content: 'ok',
  toolCalls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
  model: 'stub',
  finishReason: 'stop',
};

beforeEach(() => {
  runTreeSearchMock.mockReset();
  runDebateMock.mockReset();
  runTreeSearchMock.mockResolvedValue(STUB_RESPONSE);
  runDebateMock.mockResolvedValue(STUB_RESPONSE);
});

function mkBrain(): Brain {
  // Minimal construction — brain.call short-circuits to runTreeSearch /
  // runDebate before it touches providers, so we don't need real keys.
  const b = new Brain();
  // `providersReady` is awaited at the top of call(). The default
  // promise resolves immediately when no providers are registered.
  return b;
}

describe('Brain.call → tree-search opts piping', () => {
  it('forwards `verifier` and `breadth` to runTreeSearch on strategy: tree-search', async () => {
    const brain = mkBrain();
    brain.setStrategy('tree-search');
    const verifier = vi.fn().mockResolvedValue({ score: 1 });

    await brain.call(
      { messages: [{ role: 'user', content: 'hi' }] },
      { verifier, breadth: 5 },
    );

    expect(runTreeSearchMock).toHaveBeenCalledTimes(1);
    const passedOpts = runTreeSearchMock.mock.calls[0]?.[2];
    expect(passedOpts).toBeDefined();
    expect(passedOpts.verifier).toBe(verifier);
    expect(passedOpts.breadth).toBe(5);
    expect(runDebateMock).not.toHaveBeenCalled();
  });

  it('passes only the defined keys to runTreeSearch (omits undefined verifier)', async () => {
    const brain = mkBrain();
    brain.setStrategy('tree-search');

    await brain.call({ messages: [{ role: 'user', content: 'hi' }] });

    expect(runTreeSearchMock).toHaveBeenCalledTimes(1);
    const passedOpts = runTreeSearchMock.mock.calls[0]?.[2];
    // Empty object — no verifier, no breadth — runTreeSearch picks its
    // own defaults.
    expect(passedOpts).toEqual({});
  });

  it('routes to debate when strategy is debate AND forwards the verifier opt', async () => {
    const brain = mkBrain();
    brain.setStrategy('debate');
    const verifier = vi.fn().mockResolvedValue({ score: 1 });

    await brain.call(
      { messages: [{ role: 'user', content: 'hi' }] },
      { verifier, breadth: 5 },
    );

    expect(runDebateMock).toHaveBeenCalledTimes(1);
    expect(runTreeSearchMock).not.toHaveBeenCalled();
    // Debate receives opts with the caller's verifier (scored on the winner,
    // log-only by default); breadth stays tree-search-only.
    const debateArgs = runDebateMock.mock.calls[0];
    expect(debateArgs?.[2]).toEqual({ verifier });
  });

  it('falls through to single (no debate/tree-search) when strategy is single', async () => {
    const brain = mkBrain();
    brain.setStrategy('single');
    const verifier = vi.fn();

    // We don't await the full single path (it would touch providers). We
    // just confirm neither orchestrator was reached before the fall-through
    // starts.
    await brain.call({ messages: [{ role: 'user', content: 'hi' }] }, { verifier }).catch(() => undefined);

    expect(runTreeSearchMock).not.toHaveBeenCalled();
    expect(runDebateMock).not.toHaveBeenCalled();
  });

  it('drops non-finite breadth (NaN/Infinity) so tree-search keeps its default', async () => {
    const brain = mkBrain();
    brain.setStrategy('tree-search');

    // NaN breadth would otherwise reach runTreeSearch and Math.max(1, NaN)
    // = NaN → the for-loop never executes → "every candidate failed".
    await brain.call(
      { messages: [{ role: 'user', content: 'hi' }] },
      { breadth: Number.NaN },
    );

    expect(runTreeSearchMock).toHaveBeenCalledTimes(1);
    const passedOpts = runTreeSearchMock.mock.calls[0]?.[2];
    expect(passedOpts.breadth).toBeUndefined();

    // Same for Infinity — Math.max(1, Infinity) = Infinity, infinite loop.
    runTreeSearchMock.mockClear();
    await brain.call(
      { messages: [{ role: 'user', content: 'hi' }] },
      { breadth: Number.POSITIVE_INFINITY },
    );
    expect(runTreeSearchMock.mock.calls[0]?.[2].breadth).toBeUndefined();
  });

  it('respects `fast` tier short-circuit even if strategy is tree-search', async () => {
    const brain = mkBrain();
    brain.setStrategy('tree-search');
    const verifier = vi.fn();

    await brain.call(
      { messages: [{ role: 'user', content: 'hi' }] },
      { verifier, tier: 'fast' },
    ).catch(() => undefined);

    // fast tier always resolves to `single`, so neither multi-step
    // orchestrator runs and the verifier never reaches them.
    expect(runTreeSearchMock).not.toHaveBeenCalled();
    expect(runDebateMock).not.toHaveBeenCalled();
  });
});
