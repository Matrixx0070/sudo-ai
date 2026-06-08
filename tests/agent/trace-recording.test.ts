/**
 * @file tests/agent/trace-recording.test.ts
 * @description Theme 1 (learning flywheel, slice 1) — once a TraceStore is wired
 * via setTraceStore(), the agent loop records routing / brain / tool traces.
 * cli.ts does the boot wiring (opt-in + ZDR-gated); this validates the behavior.
 *
 *   TRACE-1  a tool-call turn records routing + brain + tool traces
 *   TRACE-2  a no-tool turn still records routing + brain (every brain call)
 *   TRACE-3  setTraceStore rejects an invalid duck-type (fail-open)
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/core/agent/loop.js';
import {
  createMockBrain,
  createMockToolRegistry,
  createMockSessionManager,
} from '../helpers/mocks.js';
import type { BrainResponse } from '../../src/core/brain/types.js';

const createMockSandboxManager = () => ({
  getWorkspaceDir: vi.fn().mockReturnValue('/mock/workspace'),
  getPolicyFor: vi.fn().mockReturnValue({}),
});

function makeLoop(brain: ReturnType<typeof createMockBrain>, registry = createMockToolRegistry()) {
  return new AgentLoop(
    brain, registry, createMockSessionManager(),
    undefined, undefined, undefined, undefined, undefined,
    createMockSandboxManager(),
  );
}

function stop(content = 'done'): BrainResponse {
  return { content, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 }, model: 'xai/grok-3-fast', finishReason: 'stop' };
}

/** A spy TraceStore satisfying the loop's duck-type (recordToolCall/BrainCall/Routing). */
function spyTraceStore() {
  return { recordToolCall: vi.fn(), recordBrainCall: vi.fn(), recordRouting: vi.fn() };
}

describe('Theme 1: agent loop trace recording', () => {
  it('TRACE-1: a tool-call turn records routing + brain + tool traces', async () => {
    const brain = createMockBrain();
    brain.call
      .mockResolvedValueOnce({
        content: 'calling a tool',
        toolCalls: [{ id: 'tc-1', name: 'system.hello', arguments: {} }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
        model: 'xai/grok-3-fast',
        finishReason: 'tool-calls',
      } as BrainResponse)
      .mockResolvedValue(stop());
    const registry = createMockToolRegistry();
    registry.execute.mockResolvedValue({ success: true, output: 'ok', data: {} });

    const loop = makeLoop(brain, registry);
    const ts = spyTraceStore();
    loop.setTraceStore(ts);

    await loop.run('test-session-id', 'do the thing');

    expect(ts.recordRouting).toHaveBeenCalled();
    expect(ts.recordBrainCall).toHaveBeenCalled();
    expect(ts.recordToolCall).toHaveBeenCalled();
  });

  it('TRACE-2: a no-tool turn still records routing + brain', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());

    const loop = makeLoop(brain);
    const ts = spyTraceStore();
    loop.setTraceStore(ts);

    await loop.run('test-session-id', 'hi');

    expect(ts.recordRouting).toHaveBeenCalled();
    expect(ts.recordBrainCall).toHaveBeenCalled();
    expect(ts.recordToolCall).not.toHaveBeenCalled();
  });

  it('TRACE-3: setTraceStore rejects an invalid duck-type (fail-open)', () => {
    const brain = createMockBrain();
    const loop = makeLoop(brain);
    // Missing recordBrainCall + recordRouting → must be rejected, not attached.
    loop.setTraceStore({ recordToolCall: vi.fn() } as any);
    expect(loop.getTraceStore()).toBeUndefined();
  });
});
