/**
 * @file tests/agent/loop-steer-inject.test.ts
 * @description GW-5 MEDIUM-2: the loop's consumer-side steer drain + tier tagging.
 * The producer path (turn handler) is covered elsewhere; this exercises the loop
 * end: a mixed-tier steer buffer drained at the iteration boundary must inject
 * user-role messages with the exact tier tags and preserve push order.
 *
 *   INJECT-1  owner steer → `[mid-run]`, untrusted steer → `[mid-run • untrusted]`,
 *             in push order, both visible to the model on the first call
 *   INJECT-2  with SUDO_MIDRUN_STEER off, the buffer is NOT drained (no injection)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentLoop } from '../../src/core/agent/loop.js';
import { getSteerBuffer, __resetSteerBufferForTest } from '../../src/core/agent/steer-buffer.js';
import {
  createMockBrain,
  createMockToolRegistry,
  createMockSessionManager,
} from '../helpers/mocks.js';
import type { BrainResponse } from '../../src/core/brain/types.js';

const SID = 'test-session-id'; // pre-seeded session in the mock manager

const createMockSandboxManager = () => ({
  getWorkspaceDir: vi.fn().mockReturnValue('/mock/workspace'),
  getPolicyFor: vi.fn().mockReturnValue({}),
});
function makeLoop(brain: ReturnType<typeof createMockBrain>) {
  return new AgentLoop(brain, createMockToolRegistry(), createMockSessionManager(), undefined, undefined, undefined, undefined, undefined, createMockSandboxManager());
}
function stop(content = 'done'): BrainResponse {
  return { content, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 }, model: 'xai/grok-3-fast', finishReason: 'stop' };
}
function injectedContents(brain: ReturnType<typeof createMockBrain>): string[] {
  const msgs = (brain.call.mock.calls[0]?.[0]?.messages ?? []) as Array<{ content?: unknown }>;
  return msgs
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter((c) => c.includes('[mid-run'));
}

describe('GW-5 loop-level steer injection (MEDIUM-2)', () => {
  beforeEach(() => { __resetSteerBufferForTest(); });
  afterEach(() => { delete process.env['SUDO_MIDRUN_STEER']; __resetSteerBufferForTest(); });

  it('INJECT-1: mixed-tier steers inject with exact tags, in order', async () => {
    process.env['SUDO_MIDRUN_STEER'] = '1';
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());

    // Pre-fill the buffer for this session: owner first, then untrusted.
    getSteerBuffer().push(SID, 'do the owner thing', 'owner');
    getSteerBuffer().push(SID, 'sneaky untrusted thing', 'untrusted');

    const loop = makeLoop(brain);
    await loop.run(SID, 'start a task');

    const injected = injectedContents(brain);
    expect(injected).toEqual([
      '[mid-run] do the owner thing',
      '[mid-run • untrusted] sneaky untrusted thing',
    ]);
    // Buffer fully drained.
    expect(getSteerBuffer().size(SID)).toBe(0);
  });

  it('INJECT-2: with steering off the buffer is not drained', async () => {
    delete process.env['SUDO_MIDRUN_STEER'];
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());

    getSteerBuffer().push(SID, 'buffered while off', 'owner');

    const loop = makeLoop(brain);
    await loop.run(SID, 'start a task');

    expect(injectedContents(brain)).toEqual([]);
    // Untouched — the OFF-default drain is a true no-op.
    expect(getSteerBuffer().size(SID)).toBe(1);
  });
});
