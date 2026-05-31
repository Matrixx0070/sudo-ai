/**
 * @file tests/agent/replan-tool-results.test.ts
 * @description Regression tests for AI_MissingToolResultsError caused by EpistemicGate REPLAN
 * leaving orphan tool_calls in session history without matching tool_result entries.
 *
 * Tests:
 *   RPT-1  Single tool call + REPLAN → session has matching role:'tool' stub
 *   RPT-2  Multiple tool calls + REPLAN → all stubs present (one per call)
 *   RPT-3  REPLAN stub carries correct toolCallId and toolName per call
 *   RPT-4  After REPLAN the loop continues without throwing (no MissingToolResultsError)
 *   RPT-5  PROCEED decision → no extra stubs synthesized
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoop } from '../../src/core/agent/loop.js';
import {
  createMockBrain,
  createMockToolRegistry,
  createMockSessionManager,
} from '../helpers/mocks.js';
import type { BrainResponse } from '../../src/core/brain/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStopResponse(content = 'replanned ok'): BrainResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
    model: 'xai/grok-3-fast',
    finishReason: 'stop',
  };
}

function makeToolCallsResponse(toolCalls: Array<{ id: string; name: string }>): BrainResponse {
  return {
    content: 'I think I should run this tool',
    toolCalls: toolCalls.map((tc) => ({ ...tc, arguments: {} })),
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
    model: 'xai/grok-3-fast',
    finishReason: 'tool-calls',
  };
}

const createMockSandboxManager = () => ({
  getWorkspaceDir: vi.fn().mockReturnValue('/mock/workspace'),
  getPolicyFor: vi.fn().mockReturnValue({}),
});

/**
 * Replace the auto-instantiated EpistemicGate on a loop instance with a spy
 * that always returns the given decision.
 */
function patchEpistemicGate(
  loop: AgentLoop,
  decision: 'REPLAN' | 'PROCEED',
  tag: string = 'CONJECTURE',
): void {
  const mockGate = {
    evaluate: vi.fn((_rationale: string, _toolName: string, _sessionId: string) => ({
      result: {
        decision,
        message: decision === 'REPLAN' ? 'blocked' : 'proceed',
      },
      tag,
      error: decision === 'REPLAN' ? { message: 'conjecture-commit' } : undefined,
      response: undefined,
    })),
  };
  // Replace the private epistemicGate field via type cast.
  (loop as unknown as { epistemicGate: typeof mockGate }).epistemicGate = mockGate;
}

// ---------------------------------------------------------------------------
// RPT-1: Single tool call + REPLAN → session has matching role:'tool' stub
// ---------------------------------------------------------------------------

describe('RPT-1: Single tool call REPLAN synthesizes a tool-result stub', () => {
  it('pushes a role:tool message for the blocked call', async () => {
    const brain = createMockBrain();

    // First brain call returns a tool-calls response (triggers REPLAN via epistemic gate).
    // Second brain call returns a stop response (after replan).
    brain.call
      .mockResolvedValueOnce(makeToolCallsResponse([{ id: 'call-abc', name: 'system.exec' }]))
      .mockResolvedValueOnce(makeStopResponse());

    const sm = createMockSessionManager();
    const loop = new AgentLoop(brain, createMockToolRegistry(), sm, undefined, undefined, undefined, undefined, undefined, createMockSandboxManager());

    patchEpistemicGate(loop, 'REPLAN', 'CONJECTURE');

    await loop.run('test-session-id', 'run hostname');

    // Retrieve the session messages.
    const session = await sm.get('test-session-id');
    const messages = session?.messages ?? [];

    // There must be a role:'tool' message with toolCallId === 'call-abc'.
    const toolResultMsgs = messages.filter(
      (m) => m.role === 'tool' && (m as { toolCallId?: string }).toolCallId === 'call-abc',
    );
    expect(toolResultMsgs.length).toBe(1);
    expect((toolResultMsgs[0] as { toolName?: string }).toolName).toBe('system.exec');
    expect((toolResultMsgs[0] as { content: string }).content).toMatch(/EpistemicGate/);
  });
});

// ---------------------------------------------------------------------------
// RPT-2: Multiple tool calls + REPLAN → all stubs present
// ---------------------------------------------------------------------------

describe('RPT-2: Multiple tool calls REPLAN synthesizes a stub for EACH call', () => {
  it('pushes role:tool messages for all blocked calls', async () => {
    const brain = createMockBrain();

    brain.call
      .mockResolvedValueOnce(
        makeToolCallsResponse([
          { id: 'call-1', name: 'system.exec' },
          { id: 'call-2', name: 'files.read' },
        ]),
      )
      .mockResolvedValueOnce(makeStopResponse());

    const sm = createMockSessionManager();
    const loop = new AgentLoop(brain, createMockToolRegistry(), sm, undefined, undefined, undefined, undefined, undefined, createMockSandboxManager());

    patchEpistemicGate(loop, 'REPLAN', 'CONJECTURE');

    await loop.run('test-session-id', 'do two things');

    const session = await sm.get('test-session-id');
    const messages = session?.messages ?? [];

    const toolResultIds = messages
      .filter((m) => m.role === 'tool')
      .map((m) => (m as { toolCallId?: string }).toolCallId);

    expect(toolResultIds).toContain('call-1');
    expect(toolResultIds).toContain('call-2');
  });
});

// ---------------------------------------------------------------------------
// RPT-3: REPLAN stubs carry correct toolCallId and toolName
// ---------------------------------------------------------------------------

describe('RPT-3: REPLAN stubs carry correct toolCallId and toolName', () => {
  it('each stub matches its originating tool call exactly', async () => {
    const brain = createMockBrain();

    const toolCalls = [
      { id: 'tc-X1', name: 'memory.search' },
      { id: 'tc-X2', name: 'network.fetch' },
    ];

    brain.call
      .mockResolvedValueOnce(makeToolCallsResponse(toolCalls))
      .mockResolvedValueOnce(makeStopResponse());

    const sm = createMockSessionManager();
    const loop = new AgentLoop(brain, createMockToolRegistry(), sm, undefined, undefined, undefined, undefined, undefined, createMockSandboxManager());

    patchEpistemicGate(loop, 'REPLAN', 'UNKNOWN');

    await loop.run('test-session-id', 'fetch and search');

    const session = await sm.get('test-session-id');
    const messages = session?.messages ?? [];

    for (const tc of toolCalls) {
      const stub = messages.find(
        (m) => m.role === 'tool' && (m as { toolCallId?: string }).toolCallId === tc.id,
      ) as { toolCallId?: string; toolName?: string; content: string } | undefined;
      expect(stub).toBeDefined();
      expect(stub?.toolName).toBe(tc.name);
      expect(stub?.content).toMatch(/EpistemicGate/);
    }
  });
});

// ---------------------------------------------------------------------------
// RPT-4: After REPLAN the loop continues — no AI_MissingToolResultsError
// ---------------------------------------------------------------------------

describe('RPT-4: Loop completes without MissingToolResultsError after REPLAN', () => {
  it('brain.call is called twice (tool-calls then stop) and run() resolves', async () => {
    const brain = createMockBrain();

    brain.call
      .mockResolvedValueOnce(makeToolCallsResponse([{ id: 'call-999', name: 'system.exec' }]))
      .mockResolvedValueOnce(makeStopResponse('all good after replan'));

    const sm = createMockSessionManager();
    const loop = new AgentLoop(brain, createMockToolRegistry(), sm, undefined, undefined, undefined, undefined, undefined, createMockSandboxManager());

    patchEpistemicGate(loop, 'REPLAN', 'CONJECTURE');

    const result = await loop.run('test-session-id', 'run something');

    // Brain was called twice: first for the tool-calls turn, second for the replan turn.
    expect(brain.call).toHaveBeenCalledTimes(2);
    // Final response is the stop response content.
    expect(result.text).toBe('all good after replan');
  });
});

// ---------------------------------------------------------------------------
// RPT-5: PROCEED decision → no extra stubs synthesized
// ---------------------------------------------------------------------------

describe('RPT-5: PROCEED decision does not add extra tool-result stubs', () => {
  it('when gate says PROCEED, only real tool-result messages appear', async () => {
    const brain = createMockBrain();

    // Tool-calls response, then stop.
    brain.call
      .mockResolvedValueOnce(makeToolCallsResponse([{ id: 'call-ok', name: 'system.hello' }]))
      .mockResolvedValueOnce(makeStopResponse('tool ran fine'));

    const registry = createMockToolRegistry();
    registry.execute.mockResolvedValue({
      success: true,
      output: 'hello output',
      data: {},
    });

    const sm = createMockSessionManager();
    const loop = new AgentLoop(brain, registry, sm, undefined, undefined, undefined, undefined, undefined, createMockSandboxManager());

    // Gate says PROCEED — tool should actually execute.
    patchEpistemicGate(loop, 'PROCEED', 'CERTAIN');

    await loop.run('test-session-id', 'hello');

    const session = await sm.get('test-session-id');
    const messages = session?.messages ?? [];

    // The one tool-result message should have come from real execution (not a stub).
    const toolResultMsgs = messages.filter(
      (m) => m.role === 'tool' && (m as { toolCallId?: string }).toolCallId === 'call-ok',
    );
    expect(toolResultMsgs.length).toBe(1);
    // Real execution result — content should NOT contain EpistemicGate prefix.
    expect((toolResultMsgs[0] as { content: string }).content).not.toMatch(/EpistemicGate/);
  });
});
