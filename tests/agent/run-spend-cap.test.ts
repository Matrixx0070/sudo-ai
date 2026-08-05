/**
 * @file run-spend-cap.test.ts
 * @description AL1 spend halt (invariant 10): SUDO_AGENT_RUN_MAX_USD caps the
 * cumulative estimated USD of ONE agent run. Before this, nothing halted the
 * loop on spend — the token cap only triggered compaction (fail-open) — so a
 * runaway tool loop on a billed model could burn until max-iterations.
 * A breach halts at the iteration boundary and finishes the turn with the
 * same graceful fallback as max-iterations (model's own last text preferred).
 * Unset/<=0 = no cap: byte-identical legacy behavior.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentLoop } from '../../src/core/agent/loop.js';
import { runHaltNotice } from '../../src/core/agent/loop-fallback.js';
import {
  createMockBrain,
  createMockToolRegistry,
  createMockSessionManager,
} from '../helpers/mocks.js';
import type { BrainRequest, BrainResponse } from '../../src/core/brain/types.js';

const createMockSandboxManager = () => ({
  getWorkspaceDir: vi.fn().mockReturnValue('/mock/workspace'),
  getPolicyFor: vi.fn().mockReturnValue({}),
});

function makeLoop(brain: ReturnType<typeof createMockBrain>, maxIterations: number) {
  const registry = createMockToolRegistry();
  registry.execute.mockResolvedValue({ success: true, output: 'ok', data: {} });
  return new AgentLoop(
    brain, registry, createMockSessionManager(),
    { maxIterations }, undefined, undefined, undefined, undefined,
    createMockSandboxManager(),
  );
}

/** Brain that tool-calls forever, spending `usd` per call. */
function spendingBrain(usd: number) {
  const brain = createMockBrain();
  let n = 0;
  brain.call.mockImplementation(async (_req: BrainRequest): Promise<BrainResponse> => {
    n++;
    return {
      content: `working (step ${n})`,
      toolCalls: [{ id: `tc-${n}`, name: 'system.hello', arguments: { step: n } }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: usd },
      model: 'ollama/glm-5.2:cloud',
      finishReason: 'tool-calls',
    } as BrainResponse;
  });
  return { brain, calls: () => n };
}

describe('SUDO_AGENT_RUN_MAX_USD — per-run spend halt', () => {
  afterEach(() => { delete process.env['SUDO_AGENT_RUN_MAX_USD']; });

  it('SPEND-1: breach halts the loop early with a graceful fallback reply', async () => {
    process.env['SUDO_AGENT_RUN_MAX_USD'] = '1';
    const { brain, calls } = spendingBrain(0.6); // 2 calls = $1.20 >= $1
    const result = await makeLoop(brain, 50).run('test-session-id', 'do the thing');
    // Cap check runs at the iteration boundary: call 1 ($0.60 < $1) proceeds,
    // call 2 ($1.20 >= $1) is the last, iteration 3 never dispatches.
    expect(calls()).toBe(2);
    // Model's own last text + the honest spend-cap notice (autonomy blocker #2).
    expect(result.text).toBe(`working (step 2)\n\n${runHaltNotice({ kind: 'spend_cap', spendUsd: 1.2, capUsd: 1, iterations: 2 })}`);
  });

  it('SPEND-2: no env → no cap (legacy behavior, runs to max-iterations)', async () => {
    const { brain, calls } = spendingBrain(100);
    const result = await makeLoop(brain, 3).run('test-session-id', 'do the thing');
    expect(calls()).toBe(3);
    expect(result.text).toBe(`working (step 3)\n\n${runHaltNotice({ kind: 'max_iterations', iterations: 3 })}`);
  });

  it('SPEND-3: zero/garbage env values disable the cap', async () => {
    process.env['SUDO_AGENT_RUN_MAX_USD'] = 'not-a-number';
    const { brain, calls } = spendingBrain(100);
    await makeLoop(brain, 3).run('test-session-id', 'do the thing');
    expect(calls()).toBe(3);
  });

  it('SPEND-4: free-lane calls (estimatedCost 0) never trip the cap', async () => {
    process.env['SUDO_AGENT_RUN_MAX_USD'] = '0.01';
    const { brain, calls } = spendingBrain(0);
    await makeLoop(brain, 3).run('test-session-id', 'do the thing');
    expect(calls()).toBe(3);
  });

  it('SPEND-5: a normal single-reply turn under the cap is unaffected', async () => {
    process.env['SUDO_AGENT_RUN_MAX_USD'] = '1';
    const brain = createMockBrain();
    brain.call.mockResolvedValue({
      content: 'plain answer',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0.2 },
      model: 'ollama/glm-5.2:cloud',
      finishReason: 'stop',
    } as BrainResponse);
    const result = await makeLoop(brain, 10).run('test-session-id', 'hi');
    expect(result.text).toBe('plain answer');
  });
});
