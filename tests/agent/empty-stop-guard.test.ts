/**
 * Empty-stop guard: a degenerate finishReason==='stop' with empty/whitespace
 * content must NOT be delivered as a blank reply (nor persisted as an empty
 * assistant turn). The loop substitutes buildLoopFallbackReply, mirroring the
 * tool-malformed / loop-fallback branches. Kill-switch SUDO_EMPTY_STOP_GUARD=0.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
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
function makeLoop(brain: ReturnType<typeof createMockBrain>) {
  return new AgentLoop(brain, createMockToolRegistry(), createMockSessionManager(), undefined, undefined, undefined, undefined, undefined, createMockSandboxManager());
}
function stop(content: string): BrainResponse {
  return { content, toolCalls: [], usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, estimatedCost: 0 }, model: 'xai/grok-3-fast', finishReason: 'stop' };
}

describe('empty-stop guard', () => {
  afterEach(() => { delete process.env['SUDO_EMPTY_STOP_GUARD']; });

  it('substitutes a non-empty fallback for an empty stop response', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop(''));
    const result = await makeLoop(brain).run('test-session-id', 'do the thing');
    expect(result.text.trim().length).toBeGreaterThan(0); // never a blank reply
  });

  it('substitutes a fallback for a whitespace-only stop response', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop('   \n  '));
    const result = await makeLoop(brain).run('test-session-id', 'do the thing');
    expect(result.text.trim().length).toBeGreaterThan(0);
  });

  it('leaves a genuine non-empty stop response untouched', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop('Here is the real answer to your question.'));
    const result = await makeLoop(brain).run('test-session-id', 'do the thing');
    expect(result.text).toBe('Here is the real answer to your question.');
  });

  it('kill-switch=0 delivers the empty response verbatim (legacy behavior)', async () => {
    process.env['SUDO_EMPTY_STOP_GUARD'] = '0';
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop(''));
    const result = await makeLoop(brain).run('test-session-id', 'do the thing');
    expect(result.text).toBe('');
  });
});
