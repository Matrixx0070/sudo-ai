/**
 * brain-debate — Blue/Red/Revise orchestrator unit tests.
 *
 * Stubs the brain via duck-typing on `.call()` so we exercise the
 * three-round flow without touching providers or the failover chain.
 */

import { describe, it, expect, vi } from 'vitest';
import { runDebate, DEFAULT_BLUE_MODEL, DEFAULT_RED_MODEL } from '../../../src/core/brain/brain-debate.js';
import type { Brain } from '../../../src/core/brain/brain.js';
import type { BrainRequest, BrainResponse } from '../../../src/core/brain/types.js';

function mkResp(content: string, model: string, costUSD = 0.001): BrainResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, estimatedCost: costUSD },
    model,
    finishReason: 'stop',
  };
}

function baseRequest(): BrainRequest {
  return {
    messages: [{ role: 'user', content: 'Implement fib(n) in TypeScript.' }],
  };
}

describe('runDebate — Blue/Red/Revise', () => {
  it('runs all three rounds when Red returns a critique', async () => {
    const call = vi.fn<Brain['call']>()
      .mockResolvedValueOnce(mkResp('blue v1', DEFAULT_BLUE_MODEL))
      .mockResolvedValueOnce(mkResp('1. handles negative n incorrectly', DEFAULT_RED_MODEL))
      .mockResolvedValueOnce(mkResp('blue final', DEFAULT_BLUE_MODEL));
    const brain = { call } as unknown as Brain;

    const resp = await runDebate(brain, baseRequest());

    expect(call).toHaveBeenCalledTimes(3);
    expect(resp.content).toBe('blue final');
    expect(resp.model).toBe(DEFAULT_BLUE_MODEL);
    // Usage summed across all three rounds: 3 × 30 = 90 total tokens
    expect(resp.usage.totalTokens).toBe(90);
    expect(resp.usage.estimatedCost).toBeCloseTo(0.003);
  });

  it('short-circuits after Red when critique is NO_FAULTS', async () => {
    const call = vi.fn<Brain['call']>()
      .mockResolvedValueOnce(mkResp('blue answer', DEFAULT_BLUE_MODEL))
      .mockResolvedValueOnce(mkResp('NO_FAULTS', DEFAULT_RED_MODEL));
    const brain = { call } as unknown as Brain;

    const resp = await runDebate(brain, baseRequest());

    expect(call).toHaveBeenCalledTimes(2);
    expect(resp.content).toBe('blue answer');
    // Usage summed: Blue + Red rounds = 60 tokens (no Revise call)
    expect(resp.usage.totalTokens).toBe(60);
  });

  it('short-circuits after Red when critique is empty', async () => {
    const call = vi.fn<Brain['call']>()
      .mockResolvedValueOnce(mkResp('blue answer', DEFAULT_BLUE_MODEL))
      .mockResolvedValueOnce(mkResp('   ', DEFAULT_RED_MODEL));
    const brain = { call } as unknown as Brain;

    const resp = await runDebate(brain, baseRequest());

    expect(call).toHaveBeenCalledTimes(2);
    expect(resp.content).toBe('blue answer');
  });

  it('honours opts.skipCritique → only Blue runs', async () => {
    const call = vi.fn<Brain['call']>()
      .mockResolvedValueOnce(mkResp('blue only', DEFAULT_BLUE_MODEL));
    const brain = { call } as unknown as Brain;

    const resp = await runDebate(brain, baseRequest(), { skipCritique: true });

    expect(call).toHaveBeenCalledTimes(1);
    expect(resp.content).toBe('blue only');
  });

  it('falls through to Blue when Blue returns empty content', async () => {
    const call = vi.fn<Brain['call']>()
      .mockResolvedValueOnce(mkResp('', DEFAULT_BLUE_MODEL));
    const brain = { call } as unknown as Brain;

    const resp = await runDebate(brain, baseRequest());

    expect(call).toHaveBeenCalledTimes(1);
    expect(resp.content).toBe('');
  });

  it('honours opts.blueModel and opts.redModel overrides', async () => {
    const call = vi.fn<Brain['call']>()
      .mockResolvedValueOnce(mkResp('blue', 'custom/blue'))
      .mockResolvedValueOnce(mkResp('NO_FAULTS', 'custom/red'));
    const brain = { call } as unknown as Brain;

    await runDebate(brain, baseRequest(), { blueModel: 'custom/blue', redModel: 'custom/red' });

    // Round 1 Blue request
    expect(call.mock.calls[0]?.[0].model).toBe('custom/blue');
    // Round 2 Red request
    expect(call.mock.calls[1]?.[0].model).toBe('custom/red');
  });

  it('strips tools from the Red critique round so the critic cannot side-effect', async () => {
    const call = vi.fn<Brain['call']>()
      .mockResolvedValueOnce(mkResp('blue', DEFAULT_BLUE_MODEL))
      .mockResolvedValueOnce(mkResp('NO_FAULTS', DEFAULT_RED_MODEL));
    const brain = { call } as unknown as Brain;

    const reqWithTools: BrainRequest = {
      messages: [{ role: 'user', content: 'use a tool' }],
      tools: [{ type: 'function', function: { name: 'demo', description: 'd', parameters: { type: 'object', properties: {} } } }],
    };

    await runDebate(brain, reqWithTools);

    // Blue round keeps tools
    expect(call.mock.calls[0]?.[0].tools?.length).toBe(1);
    // Red critique round has tools stripped
    expect(call.mock.calls[1]?.[0].tools).toEqual([]);
  });

  it('forces strategy: single on every round to prevent recursion', async () => {
    const call = vi.fn<Brain['call']>()
      .mockResolvedValueOnce(mkResp('blue v1', DEFAULT_BLUE_MODEL))
      .mockResolvedValueOnce(mkResp('1. fix something', DEFAULT_RED_MODEL))
      .mockResolvedValueOnce(mkResp('blue final', DEFAULT_BLUE_MODEL));
    const brain = { call } as unknown as Brain;

    await runDebate(brain, baseRequest());

    expect(call.mock.calls[0]?.[1]).toEqual({ strategy: 'single' });
    expect(call.mock.calls[1]?.[1]).toEqual({ strategy: 'single' });
    expect(call.mock.calls[2]?.[1]).toEqual({ strategy: 'single' });
  });

  it('falls back to Blue when Revise returns empty content (reasoning blew its budget)', async () => {
    // Reasoning models (kimi-k2.7-code, glm-5.2) emit content only after
    // the reasoning field completes. On a hard prompt Revise can burn
    // its maxTokens budget on reasoning and finish with empty content.
    const call = vi.fn<Brain['call']>()
      .mockResolvedValueOnce(mkResp('blue draft', DEFAULT_BLUE_MODEL))
      .mockResolvedValueOnce(mkResp('1. you missed a case', DEFAULT_RED_MODEL))
      .mockResolvedValueOnce(mkResp('', DEFAULT_BLUE_MODEL)); // Revise empty
    const brain = { call } as unknown as Brain;

    const resp = await runDebate(brain, baseRequest());

    expect(call).toHaveBeenCalledTimes(3);
    // Caller sees Blue's draft, NOT the empty Revise.
    expect(resp.content).toBe('blue draft');
    // Usage still summed across all three rounds — telemetry stays honest.
    expect(resp.usage.totalTokens).toBe(90);
  });

  it('also falls back to Blue when Revise returns whitespace-only content', async () => {
    const call = vi.fn<Brain['call']>()
      .mockResolvedValueOnce(mkResp('blue draft', DEFAULT_BLUE_MODEL))
      .mockResolvedValueOnce(mkResp('1. fix something', DEFAULT_RED_MODEL))
      .mockResolvedValueOnce(mkResp('   \n\t  ', DEFAULT_BLUE_MODEL));
    const brain = { call } as unknown as Brain;

    const resp = await runDebate(brain, baseRequest());

    expect(resp.content).toBe('blue draft');
  });
});
