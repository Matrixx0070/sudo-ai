/**
 * @file tests/agent/window-user-instruction.test.ts
 * @description Regression for the sliding window evicting the current turn's
 * user instruction. A turn with many tool calls produces more than WINDOW_SIZE
 * (12) non-system messages, so prepareMessages' slice(-WINDOW_SIZE) dropped the
 * user message that STARTED the turn — the model then saw no instruction and
 * stopped ("no instruction came through"). Observed live on a web turn with 16
 * non-system messages. The window must always retain the most recent user msg.
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

function makeLoop(brain: ReturnType<typeof createMockBrain>) {
  return new AgentLoop(
    brain,
    createMockToolRegistry(),
    createMockSessionManager(),
    undefined, undefined, undefined, undefined, undefined,
    createMockSandboxManager(),
  );
}

function toolCall(name: string, id: string): BrainResponse {
  return {
    content: 'working',
    toolCalls: [{ id, name, arguments: {} }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
    model: 'xai/grok-3-fast',
    finishReason: 'tool-calls',
  };
}
function stop(content = 'done'): BrainResponse {
  return {
    content, toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
    model: 'xai/grok-3-fast', finishReason: 'stop',
  };
}

describe('sliding window — user instruction retention', () => {
  it('keeps the current turn\'s user instruction after a long multi-tool turn', async () => {
    const brain = createMockBrain();
    // 7 distinct tool calls (distinct names to stay under the 8-repeat doom-loop
    // threshold) → 14 assistant/tool messages + the user msg = 15 non-system,
    // which exceeds WINDOW_SIZE (12) and would evict the user message.
    for (let i = 0; i < 7; i++) {
      brain.call.mockResolvedValueOnce(toolCall(`system.step${i}`, `tc-${i}`));
    }
    brain.call.mockResolvedValue(stop('done'));

    const INSTRUCTION = 'XYZZY_UNIQUE_INSTRUCTION find one small improvement';
    await makeLoop(brain).run('test-session-id', INSTRUCTION);

    // The LAST brain.call (the final stop turn) must still carry the instruction.
    const calls = brain.call.mock.calls;
    expect(calls.length).toBeGreaterThan(7); // it actually iterated through the tool rounds
    const lastMsgs = ((calls[calls.length - 1]?.[0] as { messages?: Array<{ content: unknown }> })?.messages ?? []);
    const blob = lastMsgs
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(blob).toContain('XYZZY_UNIQUE_INSTRUCTION');
  });
});
