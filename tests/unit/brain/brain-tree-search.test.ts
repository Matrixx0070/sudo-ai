/**
 * brain-tree-search — Verifier-guided + Reflexion orchestrator unit tests.
 *
 * Stubs the brain via duck-typing so we exercise the candidate-loop +
 * verifier + failure-log + winner-pick flow without touching providers.
 * Each `brain.call` invocation here represents one round inside a
 * debate; the debate orchestrator (#239) is integration-tested above
 * this layer in its own suite.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runTreeSearch, defaultVerifier, treeBreadthDefault, DEFAULT_TREE_BREADTH } from '../../../src/core/brain/brain-tree-search.js';
import type { Brain } from '../../../src/core/brain/brain.js';
import type { BrainRequest, BrainResponse } from '../../../src/core/brain/types.js';

function mkResp(content: string, model = 'ollama/kimi-k2.7-code:cloud'): BrainResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, estimatedCost: 0.001 },
    model,
    finishReason: 'stop',
  };
}

function baseRequest(): BrainRequest {
  return { messages: [{ role: 'user', content: 'Solve x+1=2.' }] };
}

/**
 * Make a brain that returns the given debate-result sequence. Each debate
 * runs ≤3 rounds, so we feed enough mocks for: blue + NO_FAULTS short-
 * circuit per candidate (2 calls each). Caller can override per-test.
 */
function brainReturning(responses: BrainResponse[]): { brain: Brain; call: ReturnType<typeof vi.fn> } {
  const call = vi.fn<Brain['call']>();
  for (const r of responses) call.mockResolvedValueOnce(r);
  return { brain: { call } as unknown as Brain, call };
}

describe('runTreeSearch — verifier-guided + Reflexion', () => {
  it('runs `breadth` candidates and returns the highest-scoring one', async () => {
    // 3 candidates × (blue + NO_FAULTS) = 6 calls
    const { brain } = brainReturning([
      mkResp('candidate one is short'), mkResp('NO_FAULTS'),
      mkResp('candidate two has a longer answer that should score well'), mkResp('NO_FAULTS'),
      mkResp('candidate three also longer than twenty characters of text'), mkResp('NO_FAULTS'),
    ]);

    // Score each candidate by length so we have a deterministic ranking.
    const verifier = vi.fn((r: BrainResponse) => ({ score: (r.content?.length ?? 0) / 100 }));
    const resp = await runTreeSearch(brain, baseRequest(), { breadth: 3, verifier });

    expect(verifier).toHaveBeenCalledTimes(3);
    expect(resp.content).toBe('candidate three also longer than twenty characters of text');
  });

  it('sums usage across every round of every candidate', async () => {
    const { brain } = brainReturning([
      mkResp('a fine answer here'), mkResp('NO_FAULTS'),
      mkResp('another fine answer'),  mkResp('NO_FAULTS'),
    ]);
    const resp = await runTreeSearch(brain, baseRequest(), { breadth: 2 });

    // 4 brain.call invocations × 30 tokens each = 120
    expect(resp.usage.totalTokens).toBe(120);
    expect(resp.usage.estimatedCost).toBeCloseTo(0.004);
  });

  it('appends failed-candidate reasons to the Reflexion log for next round', async () => {
    const { brain, call } = brainReturning([
      mkResp(''),                                // candidate 1: empty → score 0
      // candidate 2 sees the failure log in its request
      mkResp('this is a much better second answer'), mkResp('NO_FAULTS'),
    ]);

    await runTreeSearch(brain, baseRequest(), { breadth: 2 });

    // Candidate 1: Blue only (empty content short-circuits the debate)
    expect(call.mock.calls[0]?.[0].messages[0]?.content).toBe('Solve x+1=2.');
    // Candidate 2: should have a prepended Reflexion message
    const secondReq = call.mock.calls[1]?.[0];
    expect(secondReq?.messages[0]?.role).toBe('user');
    expect(secondReq?.messages[0]?.content).toContain('PRIOR ATTEMPT FAILURES');
    expect(secondReq?.messages[0]?.content).toContain('empty content');
  });

  it('early-exits when a candidate aces verification AND >=1 alternative explored', async () => {
    const { brain, call } = brainReturning([
      mkResp('first answer'),  mkResp('NO_FAULTS'),
      mkResp('second answer'), mkResp('NO_FAULTS'),
      // No third candidate provided; if early-exit fails, the test errors
      // because vi.fn returns undefined.
    ]);
    const verifier = (_r: BrainResponse, _req: BrainRequest) => ({ score: 1.0 });

    const resp = await runTreeSearch(brain, baseRequest(), { breadth: 5, verifier });

    // 2 candidates × 2 rounds each = 4 calls
    expect(call).toHaveBeenCalledTimes(4);
    expect(resp.content).toBe('second answer');
  });

  it('keeps going when a single candidate throws and records it in the log', async () => {
    const call = vi.fn<Brain['call']>()
      .mockRejectedValueOnce(new Error('provider blip'))
      .mockResolvedValueOnce(mkResp('recovery answer is long enough'))
      .mockResolvedValueOnce(mkResp('NO_FAULTS'));
    const brain = { call } as unknown as Brain;

    const resp = await runTreeSearch(brain, baseRequest(), { breadth: 2 });

    expect(resp.content).toBe('recovery answer is long enough');
    // Candidate 2's request should mention the candidate-1 round error
    const secondReq = call.mock.calls[1]?.[0];
    expect(secondReq?.messages[0]?.content).toContain('round error');
    expect(secondReq?.messages[0]?.content).toContain('provider blip');
  });

  it('throws when every candidate fails', async () => {
    const call = vi.fn<Brain['call']>()
      .mockRejectedValue(new Error('total outage'));
    const brain = { call } as unknown as Brain;

    await expect(runTreeSearch(brain, baseRequest(), { breadth: 2 })).rejects.toThrow(/every candidate failed/);
  });

  it('clamps breadth to >= 1', async () => {
    const { brain, call } = brainReturning([
      mkResp('only answer'), mkResp('NO_FAULTS'),
    ]);
    await runTreeSearch(brain, baseRequest(), { breadth: 0 });
    expect(call).toHaveBeenCalledTimes(2); // 1 candidate × debate
  });
});

describe('defaultVerifier', () => {
  it('scores empty content 0', () => {
    expect(defaultVerifier(mkResp('')).score).toBe(0);
  });
  it('scores short content low', () => {
    expect(defaultVerifier(mkResp('short')).score).toBeLessThan(0.5);
  });
  it('flags refusal-style content as low', () => {
    expect(defaultVerifier(mkResp('I cannot help with that request, sorry.')).score).toBeLessThan(0.5);
  });
  it('scores plausible answers at 1.0', () => {
    expect(defaultVerifier(mkResp('Here is a perfectly reasonable answer with enough text.')).score).toBe(1.0);
  });
});

describe('tree-search — env breadth and wall-clock cap', () => {
  const savedBreadth = process.env['SUDO_BRAIN_TREE_BREADTH'];
  const savedCap = process.env['SUDO_BRAIN_TREE_MAX_MS'];

  afterEach(() => {
    if (savedBreadth === undefined) delete process.env['SUDO_BRAIN_TREE_BREADTH'];
    else process.env['SUDO_BRAIN_TREE_BREADTH'] = savedBreadth;
    if (savedCap === undefined) delete process.env['SUDO_BRAIN_TREE_MAX_MS'];
    else process.env['SUDO_BRAIN_TREE_MAX_MS'] = savedCap;
  });

  it('treeBreadthDefault honors the env with NaN/range guard', () => {
    process.env['SUDO_BRAIN_TREE_BREADTH'] = '5';
    expect(treeBreadthDefault()).toBe(5);
    process.env['SUDO_BRAIN_TREE_BREADTH'] = 'garbage';
    expect(treeBreadthDefault()).toBe(DEFAULT_TREE_BREADTH);
    process.env['SUDO_BRAIN_TREE_BREADTH'] = '0';
    expect(treeBreadthDefault()).toBe(DEFAULT_TREE_BREADTH);
    process.env['SUDO_BRAIN_TREE_BREADTH'] = '99';
    expect(treeBreadthDefault()).toBe(DEFAULT_TREE_BREADTH);
    delete process.env['SUDO_BRAIN_TREE_BREADTH'];
    expect(treeBreadthDefault()).toBe(DEFAULT_TREE_BREADTH);
  });

  it('wall-clock cap keeps best-so-far instead of generating full breadth', async () => {
    process.env['SUDO_BRAIN_TREE_MAX_MS'] = '1';
    const call = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return {
        content: 'a perfectly reasonable long answer to the request',
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCost: 0 },
        model: 'm',
        finishReason: 'stop',
      };
    });
    const brain = { call } as unknown as Brain;

    const resp = await runTreeSearch(brain, { messages: [{ role: 'user', content: 'q' }] }, {
      breadth: 3,
      skipCritique: true,
    });

    // Candidate 1 generated (10ms > 1ms cap), then the loop breaks: only one
    // debate ran instead of three.
    expect(call).toHaveBeenCalledTimes(1);
    expect(resp.content).toContain('reasonable');
  });
});
